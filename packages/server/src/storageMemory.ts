import { randomUUID } from "node:crypto";
import { keyOf } from "./opKey.js";
import type { Storage } from "./storage.js";
import type {
  DocMember,
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  Role,
  User,
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

  // userId -> User
  private readonly users = new Map<string, User>();
  // handle -> userId (for unique lookup)
  private readonly userByHandle = new Map<string, string>();
  // docId -> Map<userId, DocMember>
  private readonly members = new Map<string, Map<string, DocMember>>();

  async createDoc(opts?: { ownerId?: string }): Promise<DocMeta> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const meta: DocMeta = { id, createdAt: now, updatedAt: now };
    this.docs.set(id, meta);
    this.ops.set(id, []);
    this.seen.set(id, new Set());
    this.members.set(id, new Map());
    if (opts?.ownerId) {
      const u = this.users.get(opts.ownerId);
      if (!u) throw new Error(`unknown user ${opts.ownerId}`);
      this.members
        .get(id)!
        .set(opts.ownerId, {
          docId: id,
          userId: opts.ownerId,
          role: "owner",
          addedAt: now,
        });
    }
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

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async createUser(input: {
    handle: string;
    displayName?: string | null;
  }): Promise<User> {
    const handle = input.handle.trim();
    if (!handle) throw new Error("handle required");
    if (this.userByHandle.has(handle)) {
      throw new HandleTaken(handle);
    }
    const u: User = {
      id: randomUUID(),
      handle,
      displayName: input.displayName ?? null,
      createdAt: new Date().toISOString(),
    };
    this.users.set(u.id, u);
    this.userByHandle.set(handle, u.id);
    return u;
  }

  async getUser(userId: string): Promise<User | null> {
    return this.users.get(userId) ?? null;
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const id = this.userByHandle.get(handle);
    return id ? (this.users.get(id) ?? null) : null;
  }

  async listUsers(limit = 100): Promise<User[]> {
    return Array.from(this.users.values())
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async deleteUser(userId: string): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return;
    this.users.delete(userId);
    this.userByHandle.delete(u.handle);
    // Cascade memberships.
    for (const m of this.members.values()) m.delete(userId);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  async addMember(
    docId: string,
    userId: string,
    role: Role,
  ): Promise<DocMember> {
    if (!this.docs.has(docId)) throw new Error(`unknown doc ${docId}`);
    if (!this.users.has(userId)) throw new Error(`unknown user ${userId}`);
    let map = this.members.get(docId);
    if (!map) {
      map = new Map();
      this.members.set(docId, map);
    }
    const member: DocMember = {
      docId,
      userId,
      role,
      addedAt: new Date().toISOString(),
    };
    map.set(userId, member);
    return member;
  }

  async removeMember(docId: string, userId: string): Promise<void> {
    this.members.get(docId)?.delete(userId);
  }

  async getMember(
    docId: string,
    userId: string,
  ): Promise<DocMember | null> {
    return this.members.get(docId)?.get(userId) ?? null;
  }

  async listMembers(docId: string): Promise<DocMember[]> {
    const map = this.members.get(docId);
    if (!map) return [];
    return Array.from(map.values()).sort((a, b) =>
      a.addedAt < b.addedAt ? -1 : 1,
    );
  }

  async listDocsForUser(userId: string, limit = 100): Promise<DocMeta[]> {
    const docIds: { docId: string; addedAt: string }[] = [];
    for (const [docId, map] of this.members) {
      const m = map.get(userId);
      if (m) docIds.push({ docId, addedAt: m.addedAt });
    }
    docIds.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
    const out: DocMeta[] = [];
    for (const { docId } of docIds.slice(0, limit)) {
      const meta = this.docs.get(docId);
      if (meta) out.push(meta);
    }
    return out;
  }
}

export class HandleTaken extends Error {
  constructor(public readonly handle: string) {
    super(`handle already taken: ${handle}`);
  }
}
