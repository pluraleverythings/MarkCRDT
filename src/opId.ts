// Operation identifier used as a Lamport timestamp throughout the CRDT.
//
// Format mirrors the paper: `counter@nodeId`. Comparison is `(counter,
// nodeId)` lexicographic, with counter compared numerically and nodeId as a
// string. This total order is what every conflict-resolution rule (LWW for
// mutually-exclusive marks, RGA tie-breaking on inserts) reduces to.

export interface OpId {
  readonly counter: number;
  readonly node: string;
}

export function opId(counter: number, node: string): OpId {
  return { counter, node };
}

export function opIdEq(a: OpId, b: OpId): boolean {
  return a.counter === b.counter && a.node === b.node;
}

export function opIdCmp(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.node < b.node) return -1;
  if (a.node > b.node) return 1;
  return 0;
}

export function opIdLt(a: OpId, b: OpId): boolean {
  return opIdCmp(a, b) < 0;
}

export function opIdMax(a: OpId, b: OpId): OpId {
  return opIdCmp(a, b) >= 0 ? a : b;
}

export function opIdToString(id: OpId): string {
  return `${id.counter}@${id.node}`;
}

export function opIdFromString(s: string): OpId {
  const at = s.indexOf("@");
  if (at < 0) throw new Error(`bad OpId: ${s}`);
  const counter = Number(s.slice(0, at));
  if (!Number.isFinite(counter)) throw new Error(`bad OpId counter: ${s}`);
  return { counter, node: s.slice(at + 1) };
}
