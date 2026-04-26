import { describe, expect, it } from "vitest";
import {
  CommentManager,
  CommentStore,
  Peritext,
  type CommentOp,
} from "../src/index.js";
import type { Op } from "../src/index.js";

// Deterministic id generator so tests don't depend on Math.random.
function counter(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

function makeReplica(node: string, idPrefix: string): {
  peritext: Peritext;
  store: CommentStore;
  manager: CommentManager;
} {
  const peritext = new Peritext({ node });
  const store = new CommentStore();
  const manager = new CommentManager(peritext, store, {
    node,
    idGen: counter(idPrefix),
  });
  return { peritext, store, manager };
}

describe("CommentManager — local authoring", () => {
  it("creates a comment, attaches it to text, and resolves a range", () => {
    const { peritext, manager } = makeReplica("alice", "a");
    peritext.insert(0, "Hello world");
    const { commentId } = manager.create(0, 5, "alice", "is this English?");
    const view = manager.get(commentId);
    expect(view).toBeDefined();
    expect(view!.comment.body).toBe("is this English?");
    expect(view!.range).toEqual({ start: 0, end: 5 });
  });

  it("threads: replies preserve order by Lamport opId", () => {
    const { peritext, manager } = makeReplica("alice", "a");
    peritext.insert(0, "Hello");
    const { commentId } = manager.create(0, 5, "alice", "first");
    manager.reply(commentId, "bob", "second");
    manager.reply(commentId, "alice", "third");
    const replies = manager.get(commentId)!.comment.replies;
    expect(replies.map((r) => r.body)).toEqual(["second", "third"]);
  });

  it("resolve and unresolve flip the flag", () => {
    const { peritext, manager } = makeReplica("alice", "a");
    peritext.insert(0, "x");
    const { commentId } = manager.create(0, 1, "alice", "hm");
    expect(manager.get(commentId)!.comment.resolved).toBe(false);
    manager.resolve(commentId, "alice");
    expect(manager.get(commentId)!.comment.resolved).toBe(true);
    manager.unresolve(commentId, "alice");
    expect(manager.get(commentId)!.comment.resolved).toBe(false);
  });

  it("delete is a soft tombstone — list() hides it but the data is still there", () => {
    const { peritext, manager, store } = makeReplica("alice", "a");
    peritext.insert(0, "x");
    const { commentId } = manager.create(0, 1, "alice", "doomed");
    manager.delete(commentId);
    expect(manager.list().length).toBe(0);
    expect(store.get(commentId)).toBeUndefined();
    // But it is retrievable when explicitly asked.
    expect(store.get(commentId, { includeDeleted: true })).toBeDefined();
  });
});

describe("CommentManager — persistence past document edits", () => {
  it("comment survives even when every character it anchored to is deleted", () => {
    const { peritext, manager } = makeReplica("alice", "a");
    peritext.insert(0, "Hello world");
    const { commentId } = manager.create(0, 5, "alice", "intro");
    // Delete the underlying text.
    peritext.delete(0, 5);
    expect(peritext.text()).toBe(" world");

    // The comment is still in the side store (never garbage-collected).
    const view = manager.get(commentId);
    expect(view).toBeDefined();
    expect(view!.comment.body).toBe("intro");
    // …and listed as orphaned (range === null).
    expect(view!.range).toBeNull();
    const orphans = manager.list().filter((c) => c.range === null);
    expect(orphans.length).toBe(1);
  });
});

describe("CommentManager — two-replica convergence", () => {
  it("replays comment + mark ops and converges", () => {
    const A = makeReplica("alice", "a");
    const B = makeReplica("bob", "b");

    // Alice writes some text and adds a comment.
    const textOps: Op[] = A.peritext.insert(0, "Hello world");
    const created = A.manager.create(0, 5, "alice", "intro");

    // Ship everything to Bob.
    for (const op of textOps) B.manager.applyAny(op);
    B.manager.applyAny(created.markOp);
    B.manager.applyAny(created.commentOp);

    expect(B.manager.get(created.commentId)!.range).toEqual({
      start: 0,
      end: 5,
    });

    // Concurrent: Alice replies, Bob resolves.
    const aliceReply = A.manager.reply(created.commentId, "alice", "hi back");
    const bobResolve = B.manager.resolve(created.commentId, "bob");

    A.manager.applyAny(bobResolve);
    B.manager.applyAny(aliceReply);

    const aView = A.manager.get(created.commentId)!;
    const bView = B.manager.get(created.commentId)!;
    expect(aView.comment.replies.length).toBe(1);
    expect(bView.comment.replies.length).toBe(1);
    expect(aView.comment.resolved).toBe(true);
    expect(bView.comment.resolved).toBe(true);
  });

  it("concurrent resolve/unresolve resolves by LWW on opId", () => {
    const A = makeReplica("alice", "a");
    const B = makeReplica("bob", "b");

    const textOps: Op[] = A.peritext.insert(0, "x");
    const created = A.manager.create(0, 1, "alice", "?");
    for (const op of textOps) B.manager.applyAny(op);
    B.manager.applyAny(created.markOp);
    B.manager.applyAny(created.commentOp);

    // Concurrent: Alice resolves, Bob unresolves.
    const opA = A.manager.resolve(created.commentId, "alice");
    const opB = B.manager.unresolve(created.commentId, "bob");

    A.manager.applyAny(opB);
    B.manager.applyAny(opA);

    expect(A.manager.get(created.commentId)!.comment.resolved).toBe(
      B.manager.get(created.commentId)!.comment.resolved,
    );
  });

  it("apply is idempotent on opId for both layers", () => {
    const A = makeReplica("alice", "a");
    const B = makeReplica("bob", "b");

    const textOps: Op[] = A.peritext.insert(0, "x");
    const created = A.manager.create(0, 1, "alice", "?");
    const reply = A.manager.reply(created.commentId, "alice", "self");

    const all: (Op | CommentOp)[] = [
      ...textOps,
      created.markOp,
      created.commentOp,
      reply,
    ];
    for (const op of all) B.manager.applyAny(op);
    for (const op of all) B.manager.applyAny(op); // replay
    expect(B.manager.get(created.commentId)!.comment.replies.length).toBe(1);
  });
});

describe("CommentManager — out-of-order delivery within the side store", () => {
  it("a reply that arrives before its create is buffered and flushes later", () => {
    const A = makeReplica("alice", "a");
    const B = makeReplica("bob", "b");

    const textOps: Op[] = A.peritext.insert(0, "x");
    const created = A.manager.create(0, 1, "alice", "?");
    const reply = A.manager.reply(created.commentId, "alice", "self");

    // Bob receives the reply BEFORE the create.
    for (const op of textOps) B.manager.applyAny(op);
    B.manager.applyAny(created.markOp);
    B.manager.applyAny(reply);
    expect(B.manager.get(created.commentId)).toBeUndefined();
    // Now the create arrives — the reply should be visible.
    B.manager.applyAny(created.commentOp);
    expect(B.manager.get(created.commentId)!.comment.replies.length).toBe(1);
  });
});
