import {
  CommentManager,
  CommentStore,
  Peritext,
  type CommentOp,
  type Op as PeritextOp,
} from "@markcrdt/core";
import type { SnapshotTrigger } from "./docService.js";
import type { Storage } from "./storage.js";
import type { DocSnapshot, OpEnvelope, VersionVector } from "./types.js";

// Server-side snapshot machinery.
//
// The materialised state is built by replaying the op log through the
// core CRDT on the server. We store:
//   - the version vector folded into the snapshot
//   - the rendered text + formatted runs (for read APIs)
//   - the comments (for read APIs)
//
// Clients still hydrate from ops because the core CRDT has no
// fromState() yet — but on bootstrap we send them only ops with counter
// > snapshot.versionVector[node], i.e. the tail since the snapshot, so
// the win is in op-stream length, not in skipping replay entirely. When
// we add Peritext.fromSnapshot in the future, the server side can swap
// to true zero-replay hydration without changing the wire shape.

export class Snapshotter implements SnapshotTrigger {
  // Per-doc lock + counter: how many ops since we last snapshotted.
  private readonly opsSinceSnap = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: Storage,
    private readonly threshold: number,
  ) {}

  /**
   * Called after each successful submitOps. Coalesces concurrent calls
   * for the same doc.
   */
  async maybeSnapshot(docId: string, opsAdded = 1): Promise<void> {
    const seen = (this.opsSinceSnap.get(docId) ?? 0) + opsAdded;
    this.opsSinceSnap.set(docId, seen);
    if (seen < this.threshold) return;

    const existing = this.inflight.get(docId);
    if (existing) return existing;

    const p = this.takeSnapshot(docId).finally(() => {
      this.inflight.delete(docId);
      this.opsSinceSnap.set(docId, 0);
    });
    this.inflight.set(docId, p);
    return p;
  }

  /** Force a snapshot now (for ops endpoints / tests). */
  async takeSnapshot(docId: string): Promise<void> {
    const vv = await this.storage.versionVector(docId);
    // Replay every op through the core to materialise state.
    const ops = await this.storage.opsSince(docId, {});
    const node = `server-snap`;
    const peritext = new Peritext({ node });
    const store = new CommentStore();
    const manager = new CommentManager(peritext, store, { node });
    for (const env of ops) {
      try {
        if (env.layer === "peritext") {
          peritext.apply(env.payload as PeritextOp);
          // If it's an addMark for a comment, record the mapping.
          const op = env.payload as PeritextOp;
          if (op.action === "addMark" && op.markType === "comment") {
            manager.observeMark(op);
          }
        } else {
          manager.applyComment(env.payload as CommentOp);
        }
      } catch (err) {
        // A single bad op shouldn't kill the snapshot — log and continue.
        console.error(`snapshot replay error for doc ${docId}:`, err);
      }
    }
    const snap: DocSnapshot = {
      docId,
      versionVector: vv,
      state: {
        text: peritext.text(),
        runs: peritext.render(),
        comments: manager.list({ includeDeleted: false }).map((c) => ({
          comment: c.comment,
          range: c.range,
        })),
      },
      takenAt: new Date().toISOString(),
    };
    await this.storage.putSnapshot(snap);
  }
}

export function vvCovered(snapshotVv: VersionVector, op: OpEnvelope): boolean {
  const k = (op.payload as { opId: { counter: number; node: string } }).opId;
  return (snapshotVv[k.node] ?? 0) >= k.counter;
}
