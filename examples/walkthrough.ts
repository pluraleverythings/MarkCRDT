// Run with:  npx tsx examples/walkthrough.ts
//
// A two-replica trace: Alice creates a document, makes a few edits, ships
// the ops to Bob, then both make concurrent edits and converge.

import { Peritext, opIdToString, type Op } from "../src/index.js";

function show(label: string, p: Peritext): void {
  console.log(`\n=== ${label} ===`);
  console.log("text:  ", JSON.stringify(p.text()));
  console.log("runs:  ", JSON.stringify(p.render()));
}

function dumpOps(label: string, ops: Op[]): void {
  console.log(`\n${label} produced ${ops.length} op(s):`);
  for (const op of ops) {
    const id = opIdToString(op.opId);
    if (op.action === "insert") {
      const after = op.afterId ? opIdToString(op.afterId) : "<start>";
      console.log(`  ${id}  insert "${op.char}" after ${after}`);
    } else if (op.action === "remove") {
      console.log(`  ${id}  remove ${opIdToString(op.removedId)}`);
    } else {
      const startTxt = anchorToString(op.start);
      const endTxt = anchorToString(op.end);
      const v = op.action === "addMark" ? ` = ${JSON.stringify(op.value)}` : "";
      console.log(
        `  ${id}  ${op.action} ${op.markType}${v}  [${startTxt} .. ${endTxt})`,
      );
    }
  }
}

function anchorToString(a: import("../src/index.js").Anchor): string {
  if (a.type === "startOfText") return "^";
  if (a.type === "endOfText") return "$";
  return `${a.type}:${opIdToString(a.opId)}`;
}

// ---------------------------------------------------------------------------
// 1. Alice creates a brand-new document.
// ---------------------------------------------------------------------------

const alice = new Peritext({ node: "alice" });

const aliceOps: Op[] = [];
aliceOps.push(...alice.insert(0, "Hello world"));
dumpOps("alice typed 'Hello world'", aliceOps.slice(0, 11));

const boldHello = alice.addMark(0, 5, "bold", true);
aliceOps.push(boldHello);
dumpOps("alice bolded 'Hello'", [boldHello]);

show("alice after typing + bold", alice);

// ---------------------------------------------------------------------------
// 2. Bob joins. He starts empty and replays Alice's op log.
// ---------------------------------------------------------------------------

const bob = new Peritext({ node: "bob" });
for (const op of aliceOps) bob.apply(op);
show("bob after replaying alice's ops", bob);

// ---------------------------------------------------------------------------
// 3. Concurrent edits.
//    Alice italicises "world".
//    Bob types "!" at the end AND wraps "world" in a link.
//    Neither has seen the other's ops yet.
// ---------------------------------------------------------------------------

const aliceConcurrent: Op[] = [];
aliceConcurrent.push(alice.addMark(6, 11, "italic", true));
dumpOps("alice italicised 'world'", aliceConcurrent);

const bobConcurrent: Op[] = [];
bobConcurrent.push(...bob.insert(11, "!"));
bobConcurrent.push(
  bob.addMark(6, 11, "link", { url: "https://example.com" }),
);
dumpOps("bob added '!' and a link on 'world'", bobConcurrent);

show("alice (pre-sync)", alice);
show("bob   (pre-sync)", bob);

// ---------------------------------------------------------------------------
// 4. Exchange ops. apply() is idempotent on opId, so order doesn't matter.
// ---------------------------------------------------------------------------

for (const op of bobConcurrent) alice.apply(op);
for (const op of aliceConcurrent) bob.apply(op);

show("alice (post-sync)", alice);
show("bob   (post-sync)", bob);

// ---------------------------------------------------------------------------
// 5. They converge: same text, same formatted runs.
// ---------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });
}

console.log(
  "\nconverged?",
  alice.text() === bob.text() &&
    stableStringify(alice.render()) === stableStringify(bob.render()),
);
