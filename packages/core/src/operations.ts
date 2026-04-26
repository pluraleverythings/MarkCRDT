import type { OpId } from "./opId.js";

// Anchors as defined in the Peritext paper. An anchor pins a span boundary
// to a "gap" — either before or after a specific character — or to the
// document's start/end. The before/after distinction is what lets concurrent
// inserts at the boundary fall inside or outside the span deterministically.

export type Anchor =
  | { type: "before"; opId: OpId }
  | { type: "after"; opId: OpId }
  | { type: "startOfText" }
  | { type: "endOfText" };

// MarkValue is the per-mark payload, e.g. `true` for bold or `{ url }` for a
// link. `null` is reserved as the "remove" value used internally when a
// removeMark op wins LWW against an addMark.
export type MarkValue = unknown;

export type MarkType = string;

export interface InsertOp {
  readonly action: "insert";
  readonly opId: OpId;
  readonly afterId: OpId | null; // null = before the very first character
  readonly char: string;
}

export interface RemoveOp {
  readonly action: "remove";
  readonly opId: OpId;
  readonly removedId: OpId;
}

export interface AddMarkOp {
  readonly action: "addMark";
  readonly opId: OpId;
  readonly start: Anchor;
  readonly end: Anchor;
  readonly markType: MarkType;
  readonly value: MarkValue;
}

export interface RemoveMarkOp {
  readonly action: "removeMark";
  readonly opId: OpId;
  readonly start: Anchor;
  readonly end: Anchor;
  readonly markType: MarkType;
}

export type MarkOp = AddMarkOp | RemoveMarkOp;
export type Op = InsertOp | RemoveOp | AddMarkOp | RemoveMarkOp;
