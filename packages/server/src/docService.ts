import type { Storage } from "./storage.js";
import type {
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  VersionVector,
} from "./types.js";
import { keyOf } from "./opKey.js";

// Thin orchestration over Storage. The HTTP handlers and WebSocket
// handler both go through this so the snapshot trigger and any fan-out
// hook live in one place.
export class DocService {
  // Listeners for live op streams (the WS handler subscribes here so we
  // can fan-out without re-querying Postgres on every write).
  private readonly listeners = new Map<string, Set<(ops: OpEnvelope[]) => void>>();

  constructor(
    private readonly storage: Storage,
    private readonly snapshotter?: SnapshotTrigger,
  ) {}

  async createDoc(opts?: { ownerId?: string }): Promise<DocMeta> {
    return this.storage.createDoc(opts);
  }

  async getDoc(docId: string): Promise<DocMeta | null> {
    return this.storage.getDoc(docId);
  }

  async listDocs(limit?: number): Promise<DocMeta[]> {
    return this.storage.listDocs(limit);
  }

  /** Pass-through accessor so HTTP routes can reach storage primitives. */
  get db(): Storage {
    return this.storage;
  }

  /** Bootstrap payload for a new client: snapshot (if any) + ops since. */
  async stateForClient(
    docId: string,
    clientVv: VersionVector,
  ): Promise<{
    vv: VersionVector;
    snapshot?: DocSnapshot;
    ops: OpEnvelope[];
  }> {
    const meta = await this.storage.getDoc(docId);
    if (!meta) throw new DocNotFound(docId);
    const snap = await this.storage.latestSnapshot(docId);
    // If the client already has more than the snapshot, ignore the snapshot
    // — they don't need it, just stream the deltas.
    const baseVv = clientVv;
    const useSnapshot =
      snap && !vvDominates(baseVv, snap.versionVector) ? snap : undefined;
    const startVv: VersionVector = useSnapshot ? useSnapshot.versionVector : baseVv;
    const ops = await this.storage.opsSince(docId, startVv);
    const vv = await this.storage.versionVector(docId);
    return { vv, snapshot: useSnapshot, ops };
  }

  /**
   * Append client-submitted ops; broadcast accepted ones to live
   * subscribers; opportunistically snapshot.
   */
  async submitOps(
    docId: string,
    envs: OpEnvelope[],
  ): Promise<{ accepted: OpEnvelope[]; vv: VersionVector }> {
    if (envs.some((e) => e.docId !== docId)) {
      throw new BadEnvelope("envelope docId mismatch");
    }
    for (const e of envs) keyOf(e); // throws if malformed
    const accepted = await this.storage.appendOps(docId, envs);
    if (accepted.length > 0) {
      this.fanout(docId, accepted);
      if (this.snapshotter) {
        await this.snapshotter.maybeSnapshot(docId, accepted.length);
      }
    }
    const vv = await this.storage.versionVector(docId);
    return { accepted, vv };
  }

  /** Subscribe to live op fan-out. Returns an unsubscribe fn. */
  subscribe(docId: string, cb: (ops: OpEnvelope[]) => void): () => void {
    let set = this.listeners.get(docId);
    if (!set) {
      set = new Set();
      this.listeners.set(docId, set);
    }
    set.add(cb);
    return () => {
      set!.delete(cb);
      if (set!.size === 0) this.listeners.delete(docId);
    };
  }

  subscriberCount(docId: string): number {
    return this.listeners.get(docId)?.size ?? 0;
  }

  private fanout(docId: string, ops: OpEnvelope[]): void {
    const set = this.listeners.get(docId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(ops);
      } catch (err) {
        // Listener errors must not break the broadcast loop.
        console.error("fanout listener error", err);
      }
    }
  }
}

export interface SnapshotTrigger {
  maybeSnapshot(docId: string, opsAdded?: number): Promise<void>;
}

export class DocNotFound extends Error {
  constructor(public readonly docId: string) {
    super(`document not found: ${docId}`);
  }
}

export class BadEnvelope extends Error {}

function vvDominates(a: VersionVector, b: VersionVector): boolean {
  // a >= b for every node
  for (const node of Object.keys(b)) {
    if ((a[node] ?? 0) < (b[node] ?? 0)) return false;
  }
  return true;
}
