export { Peritext } from "./peritext.js";
export type { FormattedRun, Format } from "./peritext.js";
export type {
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
export {
  opId,
  opIdCmp,
  opIdEq,
  opIdToString,
  opIdFromString,
  type OpId,
} from "./opId.js";
export {
  registerMarkType,
  behaviorOf,
  type MarkBehavior,
  type Multiplicity,
  type Growth,
} from "./markBehavior.js";
export {
  CommentStore,
  type Comment,
  type CommentReply,
  type CommentOp,
  type CommentCreateOp,
  type CommentReplyOp,
  type CommentResolveOp,
  type CommentDeleteOp,
} from "./comments.js";
export {
  CommentManager,
  type CommentManagerOptions,
  type CommentMarkValue,
  type CommentWithRange,
  type CreateResult,
} from "./commentManager.js";
