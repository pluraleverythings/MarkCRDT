# MarkCRDT — Peritext

A TypeScript implementation of the
[Peritext](https://www.inkandswitch.com/peritext/) CRDT for collaborative
rich-text editing.

A document is a sequence of characters identified by Lamport `OpId`s
(`counter@node`). On top of the sequence sits a set of mark operations
(`addMark` / `removeMark`) whose anchors are pinned to character `OpId`s
with a `before`/`after` bias, so concurrent inserts at a span boundary fall
inside or outside the span deterministically. Conflicting mark values
(e.g. red vs. blue) collapse via Last-Write-Wins by `OpId`; non-exclusive
marks (e.g. comments) stack.

## Install / build

```
npm install
npm test           # vitest
npm run typecheck
```

## Quick start

```ts
import { Peritext } from "markcrdt";

const a = new Peritext({ node: "alice" });
a.insert(0, "Hello world");
a.addMark(0, 5, "bold", true);

const b = new Peritext({ node: "bob" });
// in real use you'd ship ops over a network; here we just replay them.
// (See `test/replay.test.ts` for an out-of-order replay example.)

console.log(a.render());
// [
//   { text: "Hello", format: { bold: true } },
//   { text: " world", format: {} },
// ]
```

## Layout

```
src/
  opId.ts          — Lamport OpId type + comparison
  operations.ts    — Op shapes (insert / remove / addMark / removeMark)
  markBehavior.ts  — per-mark-type registry (single vs multi, grow vs fixed)
  peritext.ts      — sequence CRDT + mark application + render
  index.ts         — public surface
test/
  peritext.test.ts — examples from the paper
  replay.test.ts   — idempotency, order independence, tombstones
```
