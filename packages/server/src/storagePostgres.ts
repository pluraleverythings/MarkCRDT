import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
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
import { HandleTaken } from "./storageMemory.js";

// Postgres-backed Storage. Designed for horizontal scale-out: every
// instance is stateless and operates against the shared database.
//
// Throughput characteristics:
// - appendOps:    one batched INSERT per call (idempotent ON CONFLICT)
// - opsSince:     index scan on (doc_id, op_node, op_counter)
// - versionVector: GROUP BY scan over the doc's ops (kept cheap by snapshots)
//
// To fan out across multiple server instances, layer Redis pub/sub on
// top of DocService.subscribe — out of scope here, but the seam exists.
export class PostgresStorage implements Storage {
  constructor(private readonly pool: Pool) {}

  async createDoc(opts?: { ownerId?: string }): Promise<DocMeta> {
    const id = randomUUID();
    if (!opts?.ownerId) {
      const { rows } = await this.pool.query<DocRow>(
        `INSERT INTO document (id) VALUES ($1) RETURNING id, created_at, updated_at`,
        [id],
      );
      return rowToMeta(rows[0]!);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<DocRow>(
        `INSERT INTO document (id) VALUES ($1) RETURNING id, created_at, updated_at`,
        [id],
      );
      await client.query(
        `INSERT INTO document_member (doc_id, user_id, role)
         VALUES ($1, $2, 'owner')`,
        [id, opts.ownerId],
      );
      await client.query("COMMIT");
      return rowToMeta(rows[0]!);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getDoc(docId: string): Promise<DocMeta | null> {
    const { rows } = await this.pool.query<DocRow>(
      `SELECT id, created_at, updated_at FROM document WHERE id = $1`,
      [docId],
    );
    return rows[0] ? rowToMeta(rows[0]) : null;
  }

  async listDocs(limit = 100): Promise<DocMeta[]> {
    const { rows } = await this.pool.query<DocRow>(
      `SELECT id, created_at, updated_at FROM document ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToMeta);
  }

  async touchDoc(docId: string): Promise<void> {
    await this.pool.query(
      `UPDATE document SET updated_at = now() WHERE id = $1`,
      [docId],
    );
  }

  async appendOps(docId: string, envs: OpEnvelope[]): Promise<OpEnvelope[]> {
    if (envs.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const accepted: OpEnvelope[] = [];
      // Batched INSERT … ON CONFLICT DO NOTHING with RETURNING tells us
      // which rows actually landed.
      const values: unknown[] = [];
      const tuples: string[] = [];
      let i = 1;
      for (const env of envs) {
        const k = keyOf(env);
        tuples.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
        values.push(docId, env.layer, k.node, k.counter, env.payload);
      }
      const sql = `
        INSERT INTO op (doc_id, layer, op_node, op_counter, payload)
        VALUES ${tuples.join(",")}
        ON CONFLICT DO NOTHING
        RETURNING layer, op_node, op_counter, payload
      `;
      const { rows } = await client.query<{
        layer: string;
        op_node: string;
        op_counter: string;
        payload: unknown;
      }>(sql, values);
      for (const r of rows) {
        accepted.push({
          docId,
          layer: r.layer as OpEnvelope["layer"],
          payload: r.payload as OpEnvelope["payload"],
        });
      }
      if (accepted.length > 0) {
        await client.query(
          `UPDATE document SET updated_at = now() WHERE id = $1`,
          [docId],
        );
      }
      await client.query("COMMIT");
      return accepted;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async versionVector(docId: string): Promise<VersionVector> {
    const { rows } = await this.pool.query<{
      op_node: string;
      hi: string;
    }>(
      `SELECT op_node, MAX(op_counter)::text AS hi
       FROM   op WHERE doc_id = $1 GROUP BY op_node`,
      [docId],
    );
    const vv: VersionVector = {};
    for (const r of rows) vv[r.op_node] = Number(r.hi);
    return vv;
  }

  async countOps(docId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM op WHERE doc_id = $1`,
      [docId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async opsSince(
    docId: string,
    clientVv: VersionVector,
  ): Promise<OpEnvelope[]> {
    // Build a NOT-IN-the-VV predicate. We avoid building giant OR clauses
    // by passing the VV as a JSONB and joining against it.
    const { rows } = await this.pool.query<{
      layer: string;
      payload: unknown;
    }>(
      `SELECT o.layer, o.payload
       FROM   op o
       LEFT   JOIN LATERAL (SELECT (($2::jsonb)->>o.op_node)::bigint AS hi) v ON true
       WHERE  o.doc_id = $1
         AND  (v.hi IS NULL OR o.op_counter > v.hi)
       ORDER  BY o.seq`,
      [docId, JSON.stringify(clientVv)],
    );
    return rows.map((r) => ({
      docId,
      layer: r.layer as OpEnvelope["layer"],
      payload: r.payload as OpEnvelope["payload"],
    }));
  }

  async putSnapshot(snap: DocSnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshot (doc_id, taken_at, version_vector, state)
       VALUES ($1, $2, $3, $4)`,
      [snap.docId, snap.takenAt, snap.versionVector, snap.state],
    );
  }

  async latestSnapshot(docId: string): Promise<DocSnapshot | null> {
    const { rows } = await this.pool.query<{
      doc_id: string;
      taken_at: Date;
      version_vector: unknown;
      state: unknown;
    }>(
      `SELECT doc_id, taken_at, version_vector, state
       FROM   snapshot WHERE doc_id = $1
       ORDER  BY taken_at DESC LIMIT 1`,
      [docId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      docId: r.doc_id,
      takenAt: r.taken_at.toISOString(),
      versionVector: r.version_vector as VersionVector,
      state: r.state,
    };
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async createUser(input: {
    handle: string;
    displayName?: string | null;
  }): Promise<User> {
    const id = randomUUID();
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO app_user (id, handle, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, handle, display_name, created_at`,
        [id, input.handle.trim(), input.displayName ?? null],
      );
      return rowToUser(rows[0]!);
    } catch (err) {
      // 23505 = unique_violation — translate to a typed error so callers
      // can distinguish a 409 from a 500.
      if ((err as { code?: string }).code === "23505") {
        throw new HandleTaken(input.handle);
      }
      throw err;
    }
  }

  async getUser(userId: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, handle, display_name, created_at FROM app_user WHERE id = $1`,
      [userId],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, handle, display_name, created_at FROM app_user WHERE handle = $1`,
      [handle],
    );
    return rows[0] ? rowToUser(rows[0]) : null;
  }

  async listUsers(limit = 100): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, handle, display_name, created_at FROM app_user
       ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(rowToUser);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.pool.query(`DELETE FROM app_user WHERE id = $1`, [userId]);
  }

  // -------------------------------------------------------------------------
  // Membership
  // -------------------------------------------------------------------------

  async addMember(
    docId: string,
    userId: string,
    role: Role,
  ): Promise<DocMember> {
    const { rows } = await this.pool.query<MemberRow>(
      `INSERT INTO document_member (doc_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (doc_id, user_id) DO UPDATE SET role = EXCLUDED.role
       RETURNING doc_id, user_id, role, added_at`,
      [docId, userId, role],
    );
    return rowToMember(rows[0]!);
  }

  async removeMember(docId: string, userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM document_member WHERE doc_id = $1 AND user_id = $2`,
      [docId, userId],
    );
  }

  async getMember(docId: string, userId: string): Promise<DocMember | null> {
    const { rows } = await this.pool.query<MemberRow>(
      `SELECT doc_id, user_id, role, added_at
       FROM   document_member WHERE doc_id = $1 AND user_id = $2`,
      [docId, userId],
    );
    return rows[0] ? rowToMember(rows[0]) : null;
  }

  async listMembers(docId: string): Promise<DocMember[]> {
    const { rows } = await this.pool.query<MemberRow>(
      `SELECT doc_id, user_id, role, added_at
       FROM   document_member WHERE doc_id = $1 ORDER BY added_at ASC`,
      [docId],
    );
    return rows.map(rowToMember);
  }

  async listDocsForUser(userId: string, limit = 100): Promise<DocMeta[]> {
    const { rows } = await this.pool.query<DocRow>(
      `SELECT d.id, d.created_at, d.updated_at
       FROM   document d
       JOIN   document_member m ON m.doc_id = d.id
       WHERE  m.user_id = $1
       ORDER  BY m.added_at DESC
       LIMIT  $2`,
      [userId, limit],
    );
    return rows.map(rowToMeta);
  }
}

interface UserRow {
  id: string;
  handle: string;
  display_name: string | null;
  created_at: Date;
}

interface MemberRow {
  doc_id: string;
  user_id: string;
  role: string;
  added_at: Date;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    handle: r.handle,
    displayName: r.display_name,
    createdAt: r.created_at.toISOString(),
  };
}

function rowToMember(r: MemberRow): DocMember {
  return {
    docId: r.doc_id,
    userId: r.user_id,
    role: r.role as Role,
    addedAt: r.added_at.toISOString(),
  };
}

interface DocRow {
  id: string;
  created_at: Date;
  updated_at: Date;
}

function rowToMeta(row: DocRow): DocMeta {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
