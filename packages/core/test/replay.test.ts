import { describe, expect, it } from "vitest";
import { Peritext } from "../src/index.js";
import type { Op } from "../src/index.js";

// Random replay order should not change the final state (op-based CRDT
// commutativity).
function shuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
}

// Apply with a guard: replay in any order, retrying ops whose anchors
// reference characters we haven't yet seen. This stands in for a causal
// delivery layer.
function applyEventually(p: Peritext, ops: Op[]): void {
  const queue = [...ops];
  let safety = queue.length * queue.length + 16;
  while (queue.length && safety-- > 0) {
    const op = queue.shift()!;
    try {
      p.apply(op);
    } catch {
      queue.push(op);
    }
  }
  if (queue.length) throw new Error("could not apply all ops");
}

describe("idempotency and order independence", () => {
  it("applying the same op twice is a no-op", () => {
    const a = new Peritext({ node: "A" });
    const ops: Op[] = a.insert(0, "hi");
    const b = new Peritext({ node: "B" });
    for (const op of ops) b.apply(op);
    for (const op of ops) b.apply(op);
    expect(b.text()).toBe("hi");
  });

  it("two replicas reach the same state regardless of replay order", () => {
    const author = new Peritext({ node: "A" });
    const ops: Op[] = [];
    ops.push(...author.insert(0, "Hello world"));
    ops.push(author.addMark(0, 5, "bold", true));
    ops.push(author.addMark(6, 11, "italic", true));
    ops.push(...author.insert(11, "!"));
    ops.push(author.addMark(0, 12, "color", "red"));
    ops.push(author.removeMark(2, 4, "bold"));

    const baseline = author.render();
    for (const seed of [1, 2, 3, 4, 5]) {
      const replica = new Peritext({ node: `R${seed}` });
      applyEventually(replica, shuffle(ops, seed));
      expect(replica.text()).toBe(author.text());
      expect(replica.render()).toEqual(baseline);
    }
  });
});

describe("tombstones and re-formatting", () => {
  it("deleting a character does not break the bold span around it", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "abcdef");
    p.addMark(0, 6, "bold", true);
    p.delete(2, 2); // remove "cd"
    expect(p.text()).toBe("abef");
    expect(p.render()).toEqual([{ text: "abef", format: { bold: true } }]);
  });

  it("removeMark followed by addMark of the same range turns it back on", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "abcdef");
    p.addMark(0, 6, "bold", true);
    p.removeMark(2, 4, "bold");
    p.addMark(2, 4, "bold", true);
    expect(p.render()).toEqual([{ text: "abcdef", format: { bold: true } }]);
  });
});

describe("LWW with concurrent contradictory ops", () => {
  it("addMark vs concurrent removeMark — greater opId wins", () => {
    const a = new Peritext({ node: "A" });
    const b = new Peritext({ node: "B" });
    const seed = a.insert(0, "abcdef");
    for (const op of seed) b.apply(op);

    // Both replicas already share a bold mark, but one removes while the
    // other tries to keep it on by re-adding concurrently.
    const baseBold = a.addMark(0, 6, "bold", true);
    b.apply(baseBold);

    const opAdd = a.addMark(2, 4, "bold", true);
    const opRemove = b.removeMark(2, 4, "bold");

    a.apply(opRemove);
    b.apply(opAdd);

    expect(a.render()).toEqual(b.render());
  });
});
