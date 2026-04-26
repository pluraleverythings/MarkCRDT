import {
  opId,
  opIdCmp,
  opIdEq,
  opIdToString,
  type OpId,
} from "./opId.js";
import type {
  AddMarkOp,
  Anchor,
  InsertOp,
  MarkOp,
  MarkType,
  MarkValue,
  Op,
  RemoveMarkOp,
  RemoveOp,
} from "./operations.js";
import { behaviorOf } from "./markBehavior.js";

// ---------------------------------------------------------------------------
// Internal data shapes
// ---------------------------------------------------------------------------

// One element in the visible+tombstone character sequence. `markOpsBefore`
// and `markOpsAfter` are the per-character op-sets described in the paper:
// the operations whose span includes the gap immediately before or after
// this character. They are sparse — we only materialise a set at a position
// where some mark op explicitly opens or closes a boundary.

interface CharNode {
  opId: OpId;
  char: string;
  deleted: boolean;
  markOpsBefore: Set<string> | undefined; // keyed by opIdToString(markOp.opId)
  markOpsAfter: Set<string> | undefined;
}

// ---------------------------------------------------------------------------
// Public output shapes
// ---------------------------------------------------------------------------

export type Format = Record<string, MarkValue | MarkValue[]>;

export interface FormattedRun {
  text: string;
  format: Format;
}

// ---------------------------------------------------------------------------
// Peritext
// ---------------------------------------------------------------------------

export interface PeritextOptions {
  node: string;
}

export class Peritext {
  private readonly node: string;
  private counter = 0;

  // The flat sequence: visible chars and tombstones in document order.
  private readonly seq: CharNode[] = [];

  // opIdToString(charOpId) -> index in `seq` for O(1) lookup. We never
  // remove entries, even after a tombstone, because anchors keep referring
  // to the OpId.
  private readonly indexByOpId = new Map<string, number>();

  // The complete mark op log keyed by op-id string. We keep the log so we
  // can rebuild per-character op-sets and so that LWW can compare opIds
  // against ops that may have been overridden but never deleted.
  private readonly markOps = new Map<string, MarkOp>();

  // Highest counter we've ever seen across all peers, used to keep our own
  // Lamport monotonic.
  private maxSeenCounter = 0;

  constructor(opts: PeritextOptions) {
    this.node = opts.node;
  }

  // -------------------------------------------------------------------------
  // Authoring helpers — produce ops, apply them locally, return the op for
  // broadcast. The editor would call these in response to user input.
  // -------------------------------------------------------------------------

  /** Insert `text` at visible index `index`. Returns the ops produced. */
  insert(index: number, text: string): InsertOp[] {
    if (index < 0 || index > this.length) {
      throw new RangeError(`insert index out of bounds: ${index}`);
    }
    const ops: InsertOp[] = [];
    let afterId: OpId | null = this.opIdAtVisibleBoundary(index);
    for (const ch of [...text]) {
      const op: InsertOp = {
        action: "insert",
        opId: this.nextOpId(),
        afterId,
        char: ch,
      };
      this.applyInsert(op);
      ops.push(op);
      afterId = op.opId;
    }
    return ops;
  }

  /** Delete `count` visible characters starting at visible index `index`. */
  delete(index: number, count: number): RemoveOp[] {
    if (count <= 0) return [];
    if (index < 0 || index + count > this.length) {
      throw new RangeError(`delete out of bounds: ${index}+${count}`);
    }
    const ops: RemoveOp[] = [];
    // Resolve up front: deleting one char shifts later visible indices, but
    // the underlying seq indices are stable. Resolve all targets first.
    const targets: OpId[] = [];
    let visible = 0;
    for (const node of this.seq) {
      if (node.deleted) continue;
      if (visible >= index && visible < index + count) {
        targets.push(node.opId);
      }
      visible++;
      if (visible >= index + count) break;
    }
    for (const t of targets) {
      const op: RemoveOp = {
        action: "remove",
        opId: this.nextOpId(),
        removedId: t,
      };
      this.applyRemove(op);
      ops.push(op);
    }
    return ops;
  }

  /**
   * Add a mark over [startVisible, endVisible). `endVisible` is exclusive.
   * The chosen anchor types depend on the mark's growth behavior, per the
   * paper:
   *   - growing marks (bold, italic …): start.before, end.before
   *   - fixed marks (link, comment):   start.before, end.after
   */
  addMark(
    startVisible: number,
    endVisible: number,
    markType: MarkType,
    value: MarkValue = true,
  ): AddMarkOp {
    const { start, end } = this.anchorsForRange(
      startVisible,
      endVisible,
      markType,
      "addMark",
    );
    const op: AddMarkOp = {
      action: "addMark",
      opId: this.nextOpId(),
      start,
      end,
      markType,
      value,
    };
    this.applyMarkOp(op);
    return op;
  }

  /**
   * Remove a mark over [startVisible, endVisible).
   * Anchor flip vs. addMark for fixed marks is what keeps a removed link
   * from re-growing when the user types at its old boundary.
   */
  removeMark(
    startVisible: number,
    endVisible: number,
    markType: MarkType,
  ): RemoveMarkOp {
    const { start, end } = this.anchorsForRange(
      startVisible,
      endVisible,
      markType,
      "removeMark",
    );
    const op: RemoveMarkOp = {
      action: "removeMark",
      opId: this.nextOpId(),
      start,
      end,
      markType,
    };
    this.applyMarkOp(op);
    return op;
  }

  // -------------------------------------------------------------------------
  // Remote application — applying an op authored by another replica.
  // Idempotent on op-id; safe to replay an op log in any causal order.
  // -------------------------------------------------------------------------

  apply(op: Op): void {
    this.observeCounter(op.opId.counter);
    switch (op.action) {
      case "insert":
        this.applyInsert(op);
        return;
      case "remove":
        this.applyRemove(op);
        return;
      case "addMark":
      case "removeMark":
        this.applyMarkOp(op);
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /** Visible character count (excluding tombstones). */
  get length(): number {
    let n = 0;
    for (const node of this.seq) if (!node.deleted) n++;
    return n;
  }

  /** Return the plain text (no formatting). */
  text(): string {
    let out = "";
    for (const node of this.seq) if (!node.deleted) out += node.char;
    return out;
  }

  /**
   * Render to a list of formatted runs. Adjacent runs with identical format
   * are merged. Runs containing only tombstones are skipped.
   */
  render(): FormattedRun[] {
    // The op-set "current at index i (between char i-1 and char i)" is
    // computed by walking the sparse markOpsBefore/After sets and carrying
    // the most recent one forward.
    const runs: FormattedRun[] = [];
    let active: Set<string> = new Set();

    let pendingText = "";
    let pendingFormat: Format = {};

    const flush = (): void => {
      if (pendingText.length === 0) return;
      if (
        runs.length > 0 &&
        formatEq(runs[runs.length - 1]!.format, pendingFormat)
      ) {
        runs[runs.length - 1]!.text += pendingText;
      } else {
        runs.push({ text: pendingText, format: pendingFormat });
      }
      pendingText = "";
    };

    for (const node of this.seq) {
      // Boundary "before this character".
      if (node.markOpsBefore) active = new Set(node.markOpsBefore);
      if (!node.deleted) {
        const fmt = this.opSetToFormat(active);
        if (!formatEq(fmt, pendingFormat) && pendingText.length > 0) {
          flush();
        }
        pendingFormat = fmt;
        pendingText += node.char;
      }
      // Boundary "after this character". A node only carries an `after`
      // set when a mark op opens/closes there.
      if (node.markOpsAfter) active = new Set(node.markOpsAfter);
    }
    flush();
    return runs;
  }

  /**
   * Visible range over which the given mark op is currently active. Returns
   * `null` if the op isn't applied or its active range is empty (e.g. every
   * character it covered has been deleted). Read-only — does not change the
   * CRDT state.
   */
  markRange(markOpId: OpId): { start: number; end: number } | null {
    const key = opIdToString(markOpId);
    if (!this.markOps.has(key)) return null;
    let active: Set<string> = new Set();
    let visible = 0;
    let start = -1;
    let end = -1;
    for (const node of this.seq) {
      if (node.markOpsBefore) active = new Set(node.markOpsBefore);
      if (!node.deleted) {
        if (active.has(key)) {
          if (start < 0) start = visible;
          end = visible + 1;
        }
        visible++;
      }
      if (node.markOpsAfter) active = new Set(node.markOpsAfter);
    }
    if (start < 0) return null;
    return { start, end };
  }

  /** Enumerate every applied mark op (in no particular order). */
  marks(): readonly MarkOp[] {
    return Array.from(this.markOps.values());
  }

  /** Enumerate only marks of a given type. */
  marksOfType(markType: MarkType): MarkOp[] {
    const out: MarkOp[] = [];
    for (const op of this.markOps.values()) {
      if (op.markType === markType) out.push(op);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Sequence CRDT (RGA)
  // -------------------------------------------------------------------------

  private applyInsert(op: InsertOp): void {
    const key = opIdToString(op.opId);
    if (this.indexByOpId.has(key)) return; // idempotent

    // Find the insertion point: immediately after `afterId`, but skipping
    // over any concurrent siblings whose opId is greater than ours (RGA
    // tie-break). `afterId === null` means "before the first character".
    let i: number;
    if (op.afterId === null) {
      i = 0;
    } else {
      const parentIdx = this.indexByOpId.get(opIdToString(op.afterId));
      if (parentIdx === undefined) {
        throw new Error(
          `insert references unknown afterId ${opIdToString(op.afterId)}`,
        );
      }
      i = parentIdx + 1;
    }
    while (i < this.seq.length) {
      const sibling = this.seq[i]!;
      // Walk over any node whose own afterId is the same as ours (i.e. a
      // concurrent insertion after the same parent), but stop when we'd
      // pass our own RGA priority. Per RGA, the higher opId wins the
      // earlier position, so we stop when sibling.opId < op.opId.
      if (this.isDescendantOfSameAnchor(sibling, op) && opIdCmp(sibling.opId, op.opId) > 0) {
        i++;
      } else {
        break;
      }
    }

    const node: CharNode = {
      opId: op.opId,
      char: op.char,
      deleted: false,
      markOpsBefore: undefined,
      markOpsAfter: undefined,
    };
    this.seq.splice(i, 0, node);
    // Indices after `i` have shifted; rebuild the affected slice of the map.
    for (let j = i; j < this.seq.length; j++) {
      this.indexByOpId.set(opIdToString(this.seq[j]!.opId), j);
    }
  }

  // Walk the seq linearly to test whether `node` is a concurrent sibling
  // inserted at the same anchor. We approximate by checking whether `node`'s
  // ancestor chain reaches exactly the same spot — in a flat RGA without
  // explicit tree links, the cheap check is "is node's afterId reachable
  // from op.afterId through a chain of higher-priority concurrent
  // inserts?". For correctness we simply require that node was inserted at
  // a position >= our intended slot AND has a higher opId; that is enough
  // for the standard RGA tie-break.
  private isDescendantOfSameAnchor(_node: CharNode, _op: InsertOp): boolean {
    return true;
  }

  private applyRemove(op: RemoveOp): void {
    const idx = this.indexByOpId.get(opIdToString(op.removedId));
    if (idx === undefined) return; // unknown target — ignore (could be future-proof)
    this.seq[idx]!.deleted = true;
  }

  /**
   * Translate a visible-index range into Anchors honouring the mark's
   * growth behavior. Visible boundary `i` lives between visible chars
   * (i-1) and (i). For a "grow" mark we set both boundaries to "before"
   * the char on the right of the boundary. For a "fixed" mark we set the
   * end boundary to "after" the char on the left.
   */
  private anchorsForRange(
    startVisible: number,
    endVisible: number,
    markType: MarkType,
    kind: "addMark" | "removeMark",
  ): { start: Anchor; end: Anchor } {
    if (
      startVisible < 0 ||
      endVisible < startVisible ||
      endVisible > this.length
    ) {
      throw new RangeError(
        `mark range out of bounds: [${startVisible}, ${endVisible})`,
      );
    }
    const behavior = behaviorOf(markType);
    const grow = behavior.growth === "grow";

    // For a grow mark add and remove use the same anchor pattern.
    // For a fixed mark, addMark uses (before, after) and removeMark uses
    // (after, before) — see paper §"Growing and non-growing marks".
    let startBefore: boolean;
    let endBefore: boolean;
    if (grow) {
      startBefore = true;
      endBefore = true;
    } else if (kind === "addMark") {
      startBefore = true;
      endBefore = false;
    } else {
      startBefore = false;
      endBefore = true;
    }

    const start: Anchor = startBefore
      ? this.anchorBefore(startVisible)
      : this.anchorAfter(startVisible);
    const end: Anchor = endBefore
      ? this.anchorBefore(endVisible)
      : this.anchorAfter(endVisible);
    return { start, end };
  }

  private anchorBefore(visibleIndex: number): Anchor {
    if (visibleIndex >= this.length) return { type: "endOfText" };
    const id = this.opIdAtVisibleIndex(visibleIndex);
    return { type: "before", opId: id };
  }

  private anchorAfter(visibleIndex: number): Anchor {
    if (visibleIndex === 0) return { type: "startOfText" };
    const id = this.opIdAtVisibleIndex(visibleIndex - 1);
    return { type: "after", opId: id };
  }

  // -------------------------------------------------------------------------
  // Mark op application — the core Peritext algorithm.
  // -------------------------------------------------------------------------

  private applyMarkOp(op: MarkOp): void {
    const key = opIdToString(op.opId);
    if (this.markOps.has(key)) return; // idempotent

    // Resolve anchors BEFORE recording the op — if a referenced character
    // hasn't arrived yet, resolveAnchor throws and the caller can retry.
    const startIdx = this.resolveAnchor(op.start, "start");
    const endIdx = this.resolveAnchor(op.end, "end");
    this.markOps.set(key, op);

    // Decide which slot ("before" or "after") on each character is the
    // first/last gap covered by the span. Slots are addressed in walking
    // order across the seq:
    //   ..., node[i].before, node[i].after, node[i+1].before, ...
    const startSlot = this.startSlotOf(op.start, startIdx);
    const endSlot = this.endSlotOf(op.end, endIdx);

    // Materialise BOTH boundary sets before mutating any of them. Order
    // matters: if we mutated the start set first and then materialised the
    // end by copying the nearest preceding set, the copy would include this
    // op — which is exactly what the paper says NOT to do at the end.
    if (startSlot.kind !== "off-end") this.ensureSet(startSlot);
    if (endSlot.kind !== "off-end") this.ensureSet(endSlot);

    // Now walk every materialised set in [startSlot, endSlot) and add this
    // op's id. The end slot itself is excluded.
    this.walkSlots(startSlot, endSlot, (node, side) => {
      const set = side === "before" ? node.markOpsBefore : node.markOpsAfter;
      if (set) set.add(key);
    });
  }

  private resolveAnchor(
    a: Anchor,
    which: "start" | "end",
  ): number {
    if (a.type === "startOfText") return -1;
    if (a.type === "endOfText") return this.seq.length;
    const idx = this.indexByOpId.get(opIdToString(a.opId));
    if (idx === undefined) {
      throw new Error(
        `mark ${which} anchors unknown opId ${opIdToString(a.opId)}`,
      );
    }
    return idx;
  }

  // A "slot" is one of the gaps in the seq: before or after a character, or
  // off the start/end of the document.
  private startSlotOf(a: Anchor, idx: number): Slot {
    if (a.type === "startOfText") return { kind: "off-start" };
    if (a.type === "endOfText") return { kind: "off-end" };
    return a.type === "before"
      ? { kind: "before", index: idx }
      : { kind: "after", index: idx };
  }

  private endSlotOf(a: Anchor, idx: number): Slot {
    return this.startSlotOf(a, idx);
  }

  private ensureSet(slot: Slot, addOp?: string): void {
    if (slot.kind === "off-start" || slot.kind === "off-end") return;
    const node = this.seq[slot.index]!;
    if (slot.kind === "before") {
      if (!node.markOpsBefore) {
        node.markOpsBefore = this.copyNearestPreceding(slot);
      }
      if (addOp) node.markOpsBefore.add(addOp);
    } else {
      if (!node.markOpsAfter) {
        node.markOpsAfter = this.copyNearestPreceding(slot);
      }
      if (addOp) node.markOpsAfter.add(addOp);
    }
  }

  private copyNearestPreceding(slot: Slot): Set<string> {
    // Walk backwards through the slot stream looking for any materialised
    // set; copy it. If none, the implicit set is empty.
    if (slot.kind !== "before" && slot.kind !== "after") return new Set();
    const node = this.seq[slot.index]!;
    if (slot.kind === "before") {
      if (node.markOpsBefore) return new Set(node.markOpsBefore);
    } else {
      if (node.markOpsAfter) return new Set(node.markOpsAfter);
      if (node.markOpsBefore) return new Set(node.markOpsBefore);
    }
    for (let i = slot.index - 1; i >= 0; i--) {
      const n = this.seq[i]!;
      if (n.markOpsAfter) return new Set(n.markOpsAfter);
      if (n.markOpsBefore) return new Set(n.markOpsBefore);
    }
    return new Set();
  }

  /**
   * Visit each materialised set strictly between `start` (inclusive) and
   * `end` (exclusive) in slot order, calling `cb` so the caller can mutate.
   * Slots emitted in order:
   *   ..., seq[i].before, seq[i].after, seq[i+1].before, seq[i+1].after, ...
   */
  private walkSlots(
    start: Slot,
    end: Slot,
    cb: (node: CharNode, side: "before" | "after") => void,
  ): void {
    const startStream = slotToStream(start, this.seq.length);
    const endStream = slotToStream(end, this.seq.length);
    for (let s = startStream; s < endStream; s++) {
      const i = s >> 1;
      if (i < 0 || i >= this.seq.length) continue;
      const node = this.seq[i]!;
      const side: "before" | "after" = (s & 1) === 0 ? "before" : "after";
      cb(node, side);
    }
  }

  // -------------------------------------------------------------------------
  // Op-set → Format (LWW for single-multiplicity, union for multi)
  // -------------------------------------------------------------------------

  private opSetToFormat(active: Set<string>): Format {
    // Bucket ops by markType.
    const buckets = new Map<MarkType, MarkOp[]>();
    for (const key of active) {
      const op = this.markOps.get(key);
      if (!op) continue;
      const list = buckets.get(op.markType);
      if (list) list.push(op);
      else buckets.set(op.markType, [op]);
    }

    const format: Format = {};
    for (const [type, ops] of buckets) {
      const behavior = behaviorOf(type);
      if (behavior.multiplicity === "single") {
        // LWW by opId. Ties impossible (opIds are unique).
        let winner: MarkOp = ops[0]!;
        for (let i = 1; i < ops.length; i++) {
          if (opIdCmp(ops[i]!.opId, winner.opId) > 0) winner = ops[i]!;
        }
        if (winner.action === "addMark") {
          format[type] = winner.value;
        }
        // removeMark winner → mark is off → emit nothing.
      } else {
        // multi: keep every addMark whose op-id is not "removed by" a
        // covering removeMark of greater opId. The paper's rule for
        // comments is simpler: every addMark with no matching removeMark
        // contributes; matching is by op identity (a removeMark targeting
        // a specific addMark would carry that op's id). We approximate:
        // any addMark counts if no removeMark of greater opId is in the
        // op-set.
        const adds: MarkOp[] = ops.filter((o) => o.action === "addMark");
        const removes: MarkOp[] = ops.filter((o) => o.action === "removeMark");
        const values: MarkValue[] = [];
        for (const a of adds) {
          const overridden = removes.some(
            (r) => opIdCmp(r.opId, a.opId) > 0,
          );
          if (!overridden && a.action === "addMark") values.push(a.value);
        }
        if (values.length > 0) format[type] = values;
      }
    }
    return format;
  }

  // -------------------------------------------------------------------------
  // Misc
  // -------------------------------------------------------------------------

  private nextOpId(): OpId {
    this.counter = Math.max(this.counter, this.maxSeenCounter) + 1;
    this.maxSeenCounter = this.counter;
    return opId(this.counter, this.node);
  }

  private observeCounter(c: number): void {
    if (c > this.maxSeenCounter) this.maxSeenCounter = c;
  }

  /** OpId of the visible character at `visibleIndex`. */
  private opIdAtVisibleIndex(visibleIndex: number): OpId {
    let v = 0;
    for (const node of this.seq) {
      if (node.deleted) continue;
      if (v === visibleIndex) return node.opId;
      v++;
    }
    throw new RangeError(`visible index ${visibleIndex} out of bounds`);
  }

  /**
   * For inserts: the OpId of the visible character immediately to the left
   * of the boundary at `visibleIndex`, or null if the boundary is at the
   * very start of the document. We skip over tombstones — the RGA target
   * for `afterId` is the seq character immediately to the left, including
   * tombstones, so an editor may want a different choice; we use the last
   * visible to keep semantics simple. Concurrent insertions still converge
   * via the RGA tie-break.
   */
  private opIdAtVisibleBoundary(visibleIndex: number): OpId | null {
    if (visibleIndex === 0) return null;
    return this.opIdAtVisibleIndex(visibleIndex - 1);
  }
}

// ---------------------------------------------------------------------------
// Slot helpers
// ---------------------------------------------------------------------------

type Slot =
  | { kind: "off-start" }
  | { kind: "off-end" }
  | { kind: "before"; index: number }
  | { kind: "after"; index: number };

// Map a slot to a position in the linear "slot stream":
//   off-start -> -1
//   before(i) ->  2*i        (even)
//   after(i)  ->  2*i + 1    (odd)
//   off-end   ->  2*N
//
// Decoding inside walkSlots: i = s >> 1; side = (s & 1) === 0 ? before : after.
function slotToStream(slot: Slot, n: number): number {
  switch (slot.kind) {
    case "off-start":
      return -1;
    case "before":
      return 2 * slot.index;
    case "after":
      return 2 * slot.index + 1;
    case "off-end":
      return 2 * n;
  }
}

// ---------------------------------------------------------------------------
// Format equality (shallow, with array element equality).
// ---------------------------------------------------------------------------

function formatEq(a: Format, b: Format): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in b)) return false;
    const av = a[k];
    const bv = b[k];
    if (Array.isArray(av) && Array.isArray(bv)) {
      if (av.length !== bv.length) return false;
      for (let i = 0; i < av.length; i++) {
        if (!Object.is(av[i], bv[i])) return false;
      }
    } else if (!Object.is(av, bv)) {
      return false;
    }
  }
  return true;
}

// Re-export OpId equality so tests can use it without reaching in.
export { opIdEq };
