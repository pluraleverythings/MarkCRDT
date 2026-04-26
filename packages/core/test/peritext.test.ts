import { describe, expect, it } from "vitest";
import { Peritext, opIdCmp } from "../src/index.js";
import type { Op } from "../src/index.js";

// Helper: replay every op produced on `source` onto `target` (and vice
// versa) so the two replicas converge.
function sync(a: Peritext, b: Peritext, ops: Op[], target: "a" | "b"): void {
  const dst = target === "a" ? a : b;
  for (const op of ops) dst.apply(op);
}

describe("sequence CRDT", () => {
  it("inserts single characters in order", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "Hello");
    expect(p.text()).toBe("Hello");
  });

  it("deletes by visible index", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "Hello");
    p.delete(1, 3); // remove "ell"
    expect(p.text()).toBe("Ho");
  });

  it("converges concurrent inserts at the same anchor (RGA tie-break)", () => {
    const a = new Peritext({ node: "A" });
    const b = new Peritext({ node: "B" });
    const seed = a.insert(0, "x"); // both replicas need a starting char
    sync(a, b, seed, "b");

    // Concurrently insert after the same character.
    const opsA = a.insert(1, "a");
    const opsB = b.insert(1, "b");
    sync(a, b, opsB, "a");
    sync(a, b, opsA, "b");

    expect(a.text()).toBe(b.text());
    // Higher node id wins the earlier slot per RGA: "B" > "A", so "b" first.
    expect(a.text()).toBe("xba");
  });
});

describe("growing marks (bold)", () => {
  it("renders a single bold span", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "Hello world");
    p.addMark(0, 5, "bold", true);
    expect(p.render()).toEqual([
      { text: "Hello", format: { bold: true } },
      { text: " world", format: {} },
    ]);
  });

  it("inserting at the right edge inherits bold (grow semantics)", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "Hello world");
    p.addMark(0, 5, "bold", true);
    // Type "!" right at index 5, between the bold "o" and the space.
    p.insert(5, "!");
    expect(p.text()).toBe("Hello! world");
    // The "!" was typed at the (grow) end boundary → included in bold.
    expect(p.render()).toEqual([
      { text: "Hello!", format: { bold: true } },
      { text: " world", format: {} },
    ]);
  });

  it("two replicas concurrently bolding overlapping ranges converge", () => {
    const a = new Peritext({ node: "A" });
    const b = new Peritext({ node: "B" });
    const seed = a.insert(0, "abcdef");
    sync(a, b, seed, "b");

    // A bolds [0,4) "abcd"; B bolds [2,6) "cdef" concurrently.
    const opA = a.addMark(0, 4, "bold", true);
    const opB = b.addMark(2, 6, "bold", true);
    sync(a, b, [opB], "a");
    sync(a, b, [opA], "b");

    const expected = [{ text: "abcdef", format: { bold: true } }];
    expect(a.render()).toEqual(expected);
    expect(b.render()).toEqual(expected);
  });
});

describe("LWW between addMark and removeMark", () => {
  it("a later removeMark hides the bold", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "abcdef");
    p.addMark(0, 6, "bold", true);
    p.removeMark(2, 4, "bold");
    expect(p.render()).toEqual([
      { text: "ab", format: { bold: true } },
      { text: "cd", format: {} },
      { text: "ef", format: { bold: true } },
    ]);
  });

  it("color value with greater opId wins", () => {
    const a = new Peritext({ node: "A" });
    const b = new Peritext({ node: "B" });
    const seed = a.insert(0, "abcdef");
    sync(a, b, seed, "b");

    // Both replicas concurrently set a colour over the whole range.
    const opA = a.addMark(0, 6, "color", "red");
    const opB = b.addMark(0, 6, "color", "blue");
    sync(a, b, [opB], "a");
    sync(a, b, [opA], "b");

    // The op with the greater (counter, node) wins.
    const winner = opIdCmp(opA.opId, opB.opId) > 0 ? "red" : "blue";
    const expected = [{ text: "abcdef", format: { color: winner } }];
    expect(a.render()).toEqual(expected);
    expect(b.render()).toEqual(expected);
  });
});

describe("fixed marks (link)", () => {
  it("a link does not grow when typing at the right edge", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "see docs here");
    // Mark "docs" as a link.
    p.addMark(4, 8, "link", { url: "https://example.com" });
    expect(p.text()).toBe("see docs here");

    // Insertion at position 8 (just after the link) should NOT inherit it.
    p.insert(8, "!");
    expect(p.text()).toBe("see docs! here");
    const runs = p.render();
    // The "!" must not carry the link format.
    const run = runs.find((r) => r.text.includes("!"));
    expect(run).toBeDefined();
    expect(run!.format).toEqual({});
  });
});

describe("multi-multiplicity marks (comments)", () => {
  it("two overlapping comments stack instead of LWW-collapsing", () => {
    const p = new Peritext({ node: "A" });
    p.insert(0, "abcdef");
    p.addMark(0, 4, "comment", { id: "c1", body: "first" });
    p.addMark(2, 6, "comment", { id: "c2", body: "second" });

    const runs = p.render();
    // Pick the run covering "cd" — both comments should be present.
    const overlap = runs.find((r) => r.text === "cd");
    expect(overlap).toBeDefined();
    expect(Array.isArray(overlap!.format.comment)).toBe(true);
    expect((overlap!.format.comment as unknown[]).length).toBe(2);
  });
});

describe("convergence", () => {
  it("two replicas reach the same render after exchanging all ops", () => {
    const a = new Peritext({ node: "A" });
    const b = new Peritext({ node: "B" });
    const seed = a.insert(0, "Hello world");
    sync(a, b, seed, "b");

    // Concurrent edits.
    const opsA = [
      ...a.insert(11, "!"), // append "!"
      a.addMark(0, 5, "bold", true), // bold "Hello"
    ];
    const opsB: Op[] = [
      ...b.insert(0, ">> "), // prepend ">> "
      b.addMark(6, 11, "italic", true), // italic "world"
    ];

    sync(a, b, opsB, "a");
    sync(a, b, opsA, "b");

    expect(a.text()).toBe(b.text());
    expect(a.render()).toEqual(b.render());
    expect(a.text()).toBe(">> Hello world!");
  });
});
