import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { keyOf } from "./opKey.js";
import type { Storage } from "./storage.js";
import type {
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  VersionVector,
} from "./types.js";

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

  async createDoc(): Promise<DocMeta> {
    const id = randomUUID();
    const { rows } = await this.pool.query<DocRow>(
      `INSERT INTO document (id) VALUES ($1) RETURNING id, created_at, updated_at`,
      [id],
    );
    return rowToMeta(rows[0]!);
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
