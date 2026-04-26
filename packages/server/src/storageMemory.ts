import { randomUUID } from "node:crypto";
import { keyOf } from "./opKey.js";
import type { Storage } from "./storage.js";
import type {
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  VersionVector,
} from "./types.js";

// In-memory storage for tests + local dev. Same semantics as the Postgres
// adapter (idempotent appends, ordered ops, latest snapshot wins).
//
// Production: use the Postgres adapter; this one isn't durable and
// doesn't survive restart.
export class MemoryStorage implements Storage {
  private readonly docs = new Map<string, DocMeta>();
  // doc -> ops in insertion order
  private readonly ops = new Map<string, OpEnvelope[]>();
  // doc -> set of "layer|node|counter" strings for dedupe
  private readonly seen = new Map<string, Set<string>>();
  // doc -> latest snapshot
  private readonly snaps = new Map<string, DocSnapshot>();

  async createDoc(): Promise<DocMeta> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const meta: DocMeta = { id, createdAt: now, updatedAt: now };
    this.docs.set(id, meta);
    this.ops.set(id, []);
    this.seen.set(id, new Set());
    return meta;
  }

  async getDoc(docId: string): Promise<DocMeta | null> {
    return this.docs.get(docId) ?? null;
  }

  async listDocs(limit = 100): Promise<DocMeta[]> {
    return Array.from(this.docs.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async touchDoc(docId: string): Promise<void> {
    const m = this.docs.get(docId);
    if (m) m.updatedAt = new Date().toISOString();
  }

  async appendOps(docId: string, envs: OpEnvelope[]): Promise<OpEnvelope[]> {
    const log = this.ops.get(docId);
    const seen = this.seen.get(docId);
    if (!log || !seen) throw new Error(`unknown doc ${docId}`);
    const accepted: OpEnvelope[] = [];
    for (const env of envs) {
      const k = keyOf(env);
      const dedupe = `${env.layer}|${k.node}|${k.counter}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      log.push(env);
      accepted.push(env);
    }
    if (accepted.length > 0) await this.touchDoc(docId);
    return accepted;
  }

  async versionVector(docId: string): Promise<VersionVector> {
    const log = this.ops.get(docId) ?? [];
    const vv: VersionVector = {};
    for (const env of log) {
      const k = keyOf(env);
      const cur = vv[k.node] ?? 0;
      if (k.counter > cur) vv[k.node] = k.counter;
    }
    return vv;
  }

  async countOps(docId: string): Promise<number> {
    return this.ops.get(docId)?.length ?? 0;
  }

  async opsSince(
    docId: string,
    clientVv: VersionVector,
  ): Promise<OpEnvelope[]> {
    const log = this.ops.get(docId) ?? [];
    return log.filter((env) => {
      const k = keyOf(env);
      return (clientVv[k.node] ?? 0) < k.counter;
    });
  }

  async putSnapshot(snap: DocSnapshot): Promise<void> {
    this.snaps.set(snap.docId, snap);
  }

  async latestSnapshot(docId: string): Promise<DocSnapshot | null> {
    return this.snaps.get(docId) ?? null;
  }
}
