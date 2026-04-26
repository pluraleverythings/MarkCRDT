import { opId, opIdCmp, type OpId } from "./opId.js";
import type { AddMarkOp, MarkOp } from "./operations.js";
import { Peritext } from "./peritext.js";
import {
  CommentStore,
  type Comment,
  type CommentCreateOp,
  type CommentDeleteOp,
  type CommentOp,
  type CommentReplyOp,
  type CommentResolveOp,
} from "./comments.js";

// The Peritext value carried by a comment addMark. The side store owns
// everything else; the document layer only keeps this little pointer.
export interface CommentMarkValue {
  commentId: string;
}

export interface CommentWithRange {
  comment: Comment;
  /** Visible range, or null if every covered character has been deleted. */
  range: { start: number; end: number } | null;
  /** The Peritext addMark op id that anchors the comment in the document. */
  markOpId: OpId;
}

export interface CommentManagerOptions {
  node: string;
  /** Override the random comment-id / reply-id generator. */
  idGen?: () => string;
}

// All ops produced by `create`/`reply`/`resolve`/`delete`. Both layers
// of ops are returned so the caller can broadcast them as a single batch.
export interface CreateResult {
  commentId: string;
  markOp: AddMarkOp;
  commentOp: CommentCreateOp;
}

export class CommentManager {
  private readonly node: string;
  private readonly idGen: () => string;
  private commentLamport = 0;
  private maxSeenCommentLamport = 0;

  // commentId -> Peritext mark op id, populated as create ops are observed.
  private readonly markByComment = new Map<string, OpId>();

  constructor(
    public readonly peritext: Peritext,
    public readonly store: CommentStore,
    opts: CommentManagerOptions,
  ) {
    this.node = opts.node;
    this.idGen = opts.idGen ?? defaultIdGen;
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  create(
    start: number,
    end: number,
    author: string,
    body: string,
  ): CreateResult {
    const commentId = this.idGen();
    const markOp = this.peritext.addMark(start, end, "comment", {
      commentId,
    } satisfies CommentMarkValue);
    const commentOp: CommentCreateOp = {
      kind: "comment.create",
      opId: this.nextCommentOpId(),
      commentId,
      author,
      body,
    };
    this.store.apply(commentOp);
    this.markByComment.set(commentId, markOp.opId);
    return { commentId, markOp, commentOp };
  }

  reply(commentId: string, author: string, body: string): CommentReplyOp {
    const op: CommentReplyOp = {
      kind: "comment.reply",
      opId: this.nextCommentOpId(),
      commentId,
      replyId: this.idGen(),
      author,
      body,
    };
    this.store.apply(op);
    return op;
  }

  resolve(commentId: string, by: string): CommentResolveOp {
    return this.setResolved(commentId, true, by);
  }

  unresolve(commentId: string, by: string): CommentResolveOp {
    return this.setResolved(commentId, false, by);
  }

  private setResolved(
    commentId: string,
    resolved: boolean,
    by: string,
  ): CommentResolveOp {
    const op: CommentResolveOp = {
      kind: "comment.resolve",
      opId: this.nextCommentOpId(),
      commentId,
      resolved,
      by,
    };
    this.store.apply(op);
    return op;
  }

  delete(commentId: string): CommentDeleteOp {
    const op: CommentDeleteOp = {
      kind: "comment.delete",
      opId: this.nextCommentOpId(),
      commentId,
    };
    this.store.apply(op);
    return op;
  }

  // -------------------------------------------------------------------------
  // Remote application
  // -------------------------------------------------------------------------

  /**
   * Apply a comment-side op authored elsewhere. Peritext ops still go
   * through `peritext.apply` directly — that layer is not modified.
   * Tracking the markByComment index also happens via `observeMark`, which
   * the caller must invoke for every applied Peritext mark op (or use
   * `applyAny`).
   */
  applyComment(op: CommentOp): void {
    this.observeCommentLamport(op.opId.counter);
    this.store.apply(op);
  }

  /**
   * Convenience: dispatch any op (Peritext op OR comment op) to the right
   * subsystem. Updates the comment-id index for comment marks.
   */
  applyAny(op: PeritextOpUnion | CommentOp): void {
    if ("kind" in op && typeof op.kind === "string" && op.kind.startsWith("comment.")) {
      this.applyComment(op as CommentOp);
      return;
    }
    const peritextOp = op as PeritextOpUnion;
    this.peritext.apply(peritextOp);
    if (peritextOp.action === "addMark" && peritextOp.markType === "comment") {
      const value = peritextOp.value as CommentMarkValue | undefined;
      if (value && typeof value.commentId === "string") {
        this.markByComment.set(value.commentId, peritextOp.opId);
      }
    }
  }

  /**
   * If you'd rather wire ops through `peritext.apply` yourself, call this
   * after each comment-typed addMark op so the manager can resolve ranges.
   */
  observeMark(op: MarkOp): void {
    if (op.action !== "addMark" || op.markType !== "comment") return;
    const value = op.value as CommentMarkValue | undefined;
    if (value && typeof value.commentId === "string") {
      this.markByComment.set(value.commentId, op.opId);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(commentId: string): CommentWithRange | undefined {
    const comment = this.store.get(commentId);
    if (!comment) return undefined;
    const markOpId = this.markByComment.get(commentId);
    if (!markOpId) {
      // Side-store has it but we never saw the Peritext mark op. Return the
      // comment with no range so the UI can still show it (e.g. orphan list).
      return { comment, range: null, markOpId: { counter: -1, node: "" } };
    }
    return {
      comment,
      range: this.peritext.markRange(markOpId),
      markOpId,
    };
  }

  list(opts: {
    includeDeleted?: boolean;
    includeResolved?: boolean;
  } = {}): CommentWithRange[] {
    return this.store
      .list(opts)
      .map((comment) => {
        const markOpId = this.markByComment.get(comment.id);
        return {
          comment,
          range: markOpId ? this.peritext.markRange(markOpId) : null,
          markOpId: markOpId ?? { counter: -1, node: "" },
        };
      })
      .sort((a, b) => opIdCmp(a.comment.createdAt, b.comment.createdAt));
  }

  // -------------------------------------------------------------------------
  // Lamport clock for comment ops only
  // -------------------------------------------------------------------------

  private nextCommentOpId(): OpId {
    this.commentLamport =
      Math.max(this.commentLamport, this.maxSeenCommentLamport) + 1;
    this.maxSeenCommentLamport = this.commentLamport;
    return opId(this.commentLamport, this.node);
  }

  private observeCommentLamport(counter: number): void {
    if (counter > this.maxSeenCommentLamport) {
      this.maxSeenCommentLamport = counter;
    }
  }
}

// Mirrors the Op union from operations.ts but referenced via an alias to
// keep the import surface small.
type PeritextOpUnion = import("./operations.js").Op;

function defaultIdGen(): string {
  // Good enough for tests / examples; a real app should use a UUID.
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
