import type {
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  VersionVector,
} from "./types.js";

// Storage interface: everything the HTTP / WS layer needs from the
// database. The Postgres and in-memory implementations both implement
// this.
//
// All methods are async so the same call sites work for either backend.
export interface Storage {
  // ---- Documents -----------------------------------------------------------
  createDoc(): Promise<DocMeta>;
  getDoc(docId: string): Promise<DocMeta | null>;
  listDocs(limit?: number): Promise<DocMeta[]>;
  touchDoc(docId: string): Promise<void>;

  // ---- Ops ----------------------------------------------------------------

  /**
   * Append ops idempotently. Implementations dedupe on (docId, layer,
   * payload.opId.counter, payload.opId.node) and return only the ops that
   * were newly inserted (in arrival order). Updates the doc's
   * `updated_at`.
   */
  appendOps(docId: string, ops: OpEnvelope[]): Promise<OpEnvelope[]>;

  /** Server's current version vector (max counter per node) for the doc. */
  versionVector(docId: string): Promise<VersionVector>;

  /** Total op count for the doc — used to decide when to snapshot. */
  countOps(docId: string): Promise<number>;

  /**
   * All ops with counter > clientVv[node] for each node, plus all ops for
   * nodes the client has never seen (clientVv[node] === undefined).
   * Returned in insertion order.
   */
  opsSince(docId: string, clientVv: VersionVector): Promise<OpEnvelope[]>;

  // ---- Snapshots ----------------------------------------------------------
  putSnapshot(snap: DocSnapshot): Promise<void>;
  latestSnapshot(docId: string): Promise<DocSnapshot | null>;
}
