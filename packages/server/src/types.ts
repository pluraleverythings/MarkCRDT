import type { CommentOp, Op as PeritextOp } from "@markcrdt/core";

// All op kinds the server stores. We tag each one with `layer` so on
// reload we can route it back to the right CRDT subsystem on the client.
export type Layer = "peritext" | "comment";

// Wire envelope: every op crossing the network is wrapped with the doc id
// and layer so it can be routed without inspecting the payload. The
// server treats payloads as opaque JSON and only reads {opId, ...} when it
// needs to sort / dedupe.
export interface OpEnvelope<TPayload = PeritextOp | CommentOp> {
  docId: string;
  layer: Layer;
  payload: TPayload;
}

// (counter, node) extracted from the payload — needed to dedupe on insert
// and to compute version vectors.
export interface OpKey {
  counter: number;
  node: string;
}

export type VersionVector = Record<string, number>;

// JSON-serialisable snapshot of a doc's full state at some version vector.
// We store enough that a fresh client can hydrate without replay.
export interface DocSnapshot {
  docId: string;
  versionVector: VersionVector; // ops up to this version are folded in
  /** Materialised state for fast hydration. Opaque to the server. */
  state: unknown;
  takenAt: string; // ISO timestamp
}

export interface DocMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Users + membership
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  handle: string;
  displayName: string | null;
  createdAt: string;
}

export type Role = "owner" | "editor" | "viewer";

export interface DocMember {
  docId: string;
  userId: string;
  role: Role;
  addedAt: string;
}

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { t: "hello"; clientId: string; vv: VersionVector }
  | { t: "ops"; ops: OpEnvelope[] }
  | { t: "ping" };

export type ServerFrame =
  | {
      t: "welcome";
      clientId: string;
      vv: VersionVector;
      snapshot?: DocSnapshot;
      ops: OpEnvelope[];
    }
  | { t: "ops"; ops: OpEnvelope[] }
  | { t: "ack"; vv: VersionVector }
  | { t: "error"; code: string; message: string }
  | { t: "pong" };
