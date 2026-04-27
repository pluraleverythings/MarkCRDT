import type {
  DocMember,
  DocMeta,
  DocSnapshot,
  OpEnvelope,
  Role,
  User,
  VersionVector,
} from "./types.js";

// Storage interface: everything the HTTP / WS layer needs from the
// database. The Postgres and in-memory implementations both implement
// this.
//
// All methods are async so the same call sites work for either backend.
export interface Storage {
  // ---- Documents -----------------------------------------------------------
  /**
   * Create a new document. If `ownerId` is given, the user is added as a
   * member with role `owner` in the same transaction.
   */
  createDoc(opts?: { ownerId?: string }): Promise<DocMeta>;
  getDoc(docId: string): Promise<DocMeta | null>;
  listDocs(limit?: number): Promise<DocMeta[]>;
  touchDoc(docId: string): Promise<void>;

  // ---- Users --------------------------------------------------------------
  /** `handle` is the unique stable name used for lookups (email-ish). */
  createUser(input: {
    handle: string;
    displayName?: string | null;
  }): Promise<User>;
  getUser(userId: string): Promise<User | null>;
  getUserByHandle(handle: string): Promise<User | null>;
  listUsers(limit?: number): Promise<User[]>;
  /** Cascades to memberships. Documents the user owned remain. */
  deleteUser(userId: string): Promise<void>;

  // ---- Membership ---------------------------------------------------------
  addMember(docId: string, userId: string, role: Role): Promise<DocMember>;
  removeMember(docId: string, userId: string): Promise<void>;
  getMember(docId: string, userId: string): Promise<DocMember | null>;
  listMembers(docId: string): Promise<DocMember[]>;
  /** Documents this user is a member of (any role), most recent first. */
  listDocsForUser(userId: string, limit?: number): Promise<DocMeta[]>;

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
