import type { MarkType, MarkValue } from "./operations.js";

// The paper distinguishes mark types by two axes:
//
//   1. Multiplicity — most marks (bold, italic, color, link) collapse to a
//      single value per character; comments stack.
//   2. Growth — most marks expand when the user types at the boundary
//      (bold's standard "before/before" anchoring); links and comments do
//      not (they use "before/after" on add and "after/before" on remove).
//
// We capture both as a registry so the editor can declare new mark types
// without touching the algorithm.

export type Multiplicity = "single" | "multi";
export type Growth = "grow" | "fixed";

export interface MarkBehavior {
  multiplicity: Multiplicity;
  growth: Growth;
}

const DEFAULT: MarkBehavior = { multiplicity: "single", growth: "grow" };

const REGISTRY: Map<MarkType, MarkBehavior> = new Map([
  ["bold", { multiplicity: "single", growth: "grow" }],
  ["italic", { multiplicity: "single", growth: "grow" }],
  ["underline", { multiplicity: "single", growth: "grow" }],
  ["strike", { multiplicity: "single", growth: "grow" }],
  ["color", { multiplicity: "single", growth: "grow" }],
  ["highlight", { multiplicity: "single", growth: "grow" }],
  ["link", { multiplicity: "single", growth: "fixed" }],
  ["comment", { multiplicity: "multi", growth: "fixed" }],
]);

export function registerMarkType(type: MarkType, behavior: MarkBehavior): void {
  REGISTRY.set(type, behavior);
}

export function behaviorOf(type: MarkType): MarkBehavior {
  return REGISTRY.get(type) ?? DEFAULT;
}

// `null` value on a single-multiplicity mark is the canonical "this mark is
// off". The render step strips entries whose value is null after LWW.
export function isUnset(value: MarkValue): boolean {
  return value === null;
}
