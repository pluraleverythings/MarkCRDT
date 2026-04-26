import { opIdCmp, opIdToString, type OpId } from "./opId.js";

// Side-store types. Comments live alongside the Peritext document; the
// only link from the document is an `addMark("comment", { commentId })`
// whose value carries this id. Everything else — body, replies, resolve
// state, deletion — is here.

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: OpId;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: OpId;
  resolved: boolean;
  resolvedBy: string | undefined;
  resolvedAt: OpId | undefined;
  replies: CommentReply[];
  deleted: boolean;
}

// Op-based CRDT for the side store. Each op is independent of the
// Peritext op log and uses its own Lamport clock (the manager owns it).

export interface CommentCreateOp {
  kind: "comment.create";
  opId: OpId;
  commentId: string;
  author: string;
  body: string;
}

export interface CommentReplyOp {
  kind: "comment.reply";
  opId: OpId;
  commentId: string;
  replyId: string;
  author: string;
  body: string;
}

export interface CommentResolveOp {
  kind: "comment.resolve";
  opId: OpId;
  commentId: string;
  resolved: boolean;
  by: string;
}

export interface CommentDeleteOp {
  kind: "comment.delete";
  opId: OpId;
  commentId: string;
}

export type CommentOp =
  | CommentCreateOp
  | CommentReplyOp
  | CommentResolveOp
  | CommentDeleteOp;

export class CommentStore {
  private readonly comments = new Map<string, Comment>();
  private readonly applied = new Set<string>();
  private readonly resolveWinner = new Map<string, OpId>();

  // Replies that arrived before their create op. We hold them here and
  // flush when create is observed. A causal-delivery layer would make this
  // unnecessary, but it costs nothing to be safe.
  private readonly pendingReplies = new Map<string, CommentReplyOp[]>();
  private readonly pendingResolves = new Map<string, CommentResolveOp[]>();
  private readonly pendingDeletes = new Set<string>();

  apply(op: CommentOp): void {
    const key = opIdToString(op.opId);
    if (this.applied.has(key)) return;
    this.applied.add(key);

    switch (op.kind) {
      case "comment.create":
        this.applyCreate(op);
        return;
      case "comment.reply":
        this.applyReply(op);
        return;
      case "comment.resolve":
        this.applyResolve(op);
        return;
      case "comment.delete":
        this.applyDelete(op);
        return;
    }
  }

  private applyCreate(op: CommentCreateOp): void {
    if (!this.comments.has(op.commentId)) {
      this.comments.set(op.commentId, {
        id: op.commentId,
        author: op.author,
        body: op.body,
        createdAt: op.opId,
        resolved: false,
        resolvedBy: undefined,
        resolvedAt: undefined,
        replies: [],
        deleted: this.pendingDeletes.delete(op.commentId) ? true : false,
      });
    }
    // Flush anything that arrived before the create.
    const replies = this.pendingReplies.get(op.commentId);
    if (replies) {
      this.pendingReplies.delete(op.commentId);
      for (const r of replies) this.applyReply(r);
    }
    const resolves = this.pendingResolves.get(op.commentId);
    if (resolves) {
      this.pendingResolves.delete(op.commentId);
      for (const r of resolves) this.applyResolve(r);
    }
  }

  private applyReply(op: CommentReplyOp): void {
    const c = this.comments.get(op.commentId);
    if (!c) {
      const list = this.pendingReplies.get(op.commentId) ?? [];
      list.push(op);
      this.pendingReplies.set(op.commentId, list);
      return;
    }
    if (c.replies.some((r) => r.id === op.replyId)) return;
    c.replies.push({
      id: op.replyId,
      author: op.author,
      body: op.body,
      createdAt: op.opId,
    });
    c.replies.sort((a, b) => opIdCmp(a.createdAt, b.createdAt));
  }

  private applyResolve(op: CommentResolveOp): void {
    const c = this.comments.get(op.commentId);
    if (!c) {
      const list = this.pendingResolves.get(op.commentId) ?? [];
      list.push(op);
      this.pendingResolves.set(op.commentId, list);
      return;
    }
    const prev = this.resolveWinner.get(op.commentId);
    if (prev && opIdCmp(op.opId, prev) <= 0) return;
    c.resolved = op.resolved;
    c.resolvedBy = op.by;
    c.resolvedAt = op.opId;
    this.resolveWinner.set(op.commentId, op.opId);
  }

  private applyDelete(op: CommentDeleteOp): void {
    const c = this.comments.get(op.commentId);
    if (!c) {
      // Hold the tombstone until create arrives.
      this.pendingDeletes.add(op.commentId);
      return;
    }
    c.deleted = true;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Includes deleted comments only when explicitly requested. */
  get(id: string, opts: { includeDeleted?: boolean } = {}): Comment | undefined {
    const c = this.comments.get(id);
    if (!c) return undefined;
    if (c.deleted && !opts.includeDeleted) return undefined;
    return c;
  }

  list(opts: {
    includeDeleted?: boolean;
    includeResolved?: boolean;
  } = {}): Comment[] {
    const includeDeleted = opts.includeDeleted ?? false;
    const includeResolved = opts.includeResolved ?? true;
    const out: Comment[] = [];
    for (const c of this.comments.values()) {
      if (c.deleted && !includeDeleted) continue;
      if (c.resolved && !includeResolved) continue;
      out.push(c);
    }
    return out;
  }
}
