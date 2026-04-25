# MarkCRDT — Design

A CRDT for collaborative Markdown editing. This document is organised
top-down: first the conceptual data model, then the database schema, then the
operation set, then the API (REST + WebSocket sync protocol).

The goals are:

1. **Correct merging** of concurrent edits with no central coordinator.
2. **Markdown fidelity** — the in-memory state is structured Markdown, not a
   flat string. Bold/italic/link boundaries survive concurrent edits.
3. **Server-assisted persistence** — the server is a replica and a relay, but
   does not arbitrate ordering beyond enforcing causality.
4. **Bounded metadata** — tombstones and history can be compacted without
   breaking offline replicas that have synced within a known retention window.

Non-goals: rich-media embeds with their own CRDTs, ACL/permission model,
end-to-end encryption.

---

## 1. Document model

A document is a **tree of blocks** with **text and inline marks** at the
leaves.

```
Document
└── Block (root, type=doc)
    ├── Block (heading, level=1)
    │   └── Text "Introduction" + marks
    ├── Block (paragraph)
    │   └── Text "Hello world" + marks
    └── Block (list, ordered=false)
        ├── Block (list_item)
        │   └── Block (paragraph) → Text "first"
        └── Block (list_item)
            └── Block (paragraph) → Text "second"
```

### 1.1 Block tree CRDT

Blocks are ordered children of a parent. Order is maintained by a **list
CRDT** (Yjs/Fugue-style: each insertion records the IDs of its left and
right neighbours at insertion time; ties broken by `(lamport, replica_id)`).

A block carries:

| Field        | Notes                                                              |
| ------------ | ------------------------------------------------------------------ |
| `id`         | `OpId = (lamport, replica_id)`. Globally unique, immutable.        |
| `parent_id`  | `OpId` of parent block. The root has `parent_id = NULL`.           |
| `type`       | `doc`, `paragraph`, `heading`, `list`, `list_item`, `blockquote`, `code_block`, `thematic_break`, `table`, `table_row`, `table_cell`, `html_block`. |
| `attrs`      | Type-specific JSON (heading level, code language, list start, …).  |
| `tombstone`  | Boolean. Deleted blocks are kept until GC.                         |

Block **moves** (e.g. drag-and-drop a list item) are represented as a single
`MoveBlock` op with a Lamport-ordered "last writer wins" rule on the
`(parent_id, position)` pair. To prevent cycles, an op that would make a
block its own ancestor is dropped at apply time (Kleppmann/Bieniusa
move-tree algorithm).

`attrs` is a small **LWW-Map** keyed by attribute name; each entry stores
`(value, lamport, replica_id)` and the highest `(lamport, replica_id)` wins.

### 1.2 Text sequence CRDT

Each text-bearing leaf block (`paragraph`, `heading`, `code_block`, …) owns
a sequence of **characters**. We use a Fugue/Yjs-style positional CRDT:

- Each insertion is `(op_id, value, left_origin, right_origin)`.
- `left_origin` / `right_origin` are the `op_id` of the characters that were
  to the immediate left / right at the moment of insertion (or sentinel
  block start / block end).
- Ordering is determined recursively: among characters sharing the same
  origins, ties are broken by `(lamport, replica_id)`; concurrent
  insertions interleave deterministically.

Deletion is a tombstone bit on the character; the position survives so that
marks and other ops can still reference it.

The character is the unit; grapheme clustering is a presentation concern.
`code_block` uses the same sequence type but ignores marks.

### 1.3 Inline marks (Peritext-style)

Inline formatting is **not** stored as nested blocks. It is stored as a set
of **mark spans** that point to stable text positions:

```
Mark = {
  id:        OpId,
  block_id:  OpId,
  type:      'strong' | 'emphasis' | 'code' | 'strike' | 'link' | 'image_ref' | …,
  attrs:     JSON,           -- e.g. { href: "https://…" } for links
  start:     { anchor: OpId, bias: 'before'|'after' },
  end:       { anchor: OpId, bias: 'before'|'after' },
  tombstone: bool
}
```

`anchor` is the `op_id` of a character (or a block sentinel). `bias`
determines which side of the anchor the boundary "sticks" to when new
characters are inserted exactly at that position. This is the Peritext
property that keeps `**bold**` from accidentally swallowing a space typed
just after it.

Conflict rules:

- **Same-type marks** with overlapping ranges merge into one span (union).
- **Link `attrs`** use LWW per attribute.
- A `RemoveMark` op carves a hole in any same-type span it intersects; the
  span is split into up-to-two surviving fragments. Removal wins over
  concurrent additions of the same mark on the same range only when its
  Lamport timestamp is strictly greater (otherwise: re-add wins). This
  matches the Peritext semantics for "unbold then concurrent bold".

---

## 2. Identifiers and causality

### 2.1 `OpId`

```
OpId := (lamport: uint64, replica_id: uuid)
```

`replica_id` is the per-device identifier minted on first launch. `lamport`
is monotonically increasing per replica; on receiving a remote op with
`l_remote`, the local clock advances to `max(local, l_remote) + 1`.

`OpId`s are total-ordered lexicographically by `(lamport, replica_id)`. This
order is used for tie-breaking, never for causality.

### 2.2 Causality

Each op carries `deps`: the minimal set of `OpId`s the producing replica had
already integrated when it produced the op. In practice we transmit a
**version vector** `vv = { replica_id → max_lamport }` per replica, and
`deps_of(op) := vv_at_production`. Receivers buffer ops whose `deps` are
not yet satisfied.

This makes the CRDT **op-based with causal delivery**, which is what the
sync protocol below assumes.

### 2.3 Document identity

```
DocumentId := uuid
```

A document is the unit of sync. Cross-document references (e.g. wiki links)
are out of scope — they are plain Markdown link text.

---

## 3. Database schema

The reference implementation targets PostgreSQL. The schema separates the
**op log** (source of truth, append-only) from **materialised state**
(derived, can be rebuilt from the log). Clients can sync from either,
depending on their freshness needs.

```sql
-- ─────────────────────── identities ───────────────────────

CREATE TABLE document (
    id             uuid PRIMARY KEY,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- Highest Lamport observed by the server replica (used for HLC seeding
    -- and op-id minting when the server itself authors ops, e.g. GC).
    server_lamport bigint      NOT NULL DEFAULT 0,
    -- Latest snapshot id, NULL until the first compaction.
    head_snapshot  uuid
);

CREATE TABLE replica (
    id           uuid PRIMARY KEY,                -- replica_id
    document_id  uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    label        text,                            -- e.g. "alice@laptop"
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON replica (document_id);

-- ─────────────────────── op log ──────────────────────────

-- Single append-only log per document. Every op below is wrapped in this row.
CREATE TABLE op (
    document_id   uuid       NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    lamport       bigint     NOT NULL,
    replica_id    uuid       NOT NULL,
    kind          text       NOT NULL,            -- see §4
    -- Causal dependencies as a compact version vector delta:
    -- { replica_id (uuid) → lamport (bigint) }.
    deps          jsonb      NOT NULL,
    payload       jsonb      NOT NULL,            -- op-specific body
    received_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, lamport, replica_id)
);
-- For sync: "give me ops > vv" scan.
CREATE INDEX op_by_replica ON op (document_id, replica_id, lamport);

-- ─────────────────────── materialised state ──────────────

CREATE TABLE block (
    document_id   uuid   NOT NULL,
    -- block_id is OpId; stored as two columns for cheap joins / indexes.
    id_lamport    bigint NOT NULL,
    id_replica    uuid   NOT NULL,
    parent_lamport bigint,                        -- NULL only for root
    parent_replica uuid,
    type          text   NOT NULL,
    attrs         jsonb  NOT NULL DEFAULT '{}'::jsonb,
    -- Sort key derived from the list-CRDT positional algorithm. Recomputed
    -- when neighbours change. Two siblings are ordered by `position`.
    position      bytea  NOT NULL,                -- variable-length key
    tombstone     bool   NOT NULL DEFAULT false,
    PRIMARY KEY (document_id, id_lamport, id_replica)
);
CREATE INDEX block_children
    ON block (document_id, parent_lamport, parent_replica, position)
    WHERE NOT tombstone;

CREATE TABLE text_char (
    document_id   uuid   NOT NULL,
    block_lamport bigint NOT NULL,
    block_replica uuid   NOT NULL,
    id_lamport    bigint NOT NULL,
    id_replica    uuid   NOT NULL,
    value         text   NOT NULL,                -- always one Unicode scalar
    left_lamport  bigint,                         -- origin neighbour at insert
    left_replica  uuid,
    right_lamport bigint,
    right_replica uuid,
    position      bytea  NOT NULL,                -- materialised order key
    tombstone     bool   NOT NULL DEFAULT false,
    PRIMARY KEY (document_id, block_lamport, block_replica,
                 id_lamport, id_replica)
);
CREATE INDEX text_char_in_block
    ON text_char (document_id, block_lamport, block_replica, position)
    WHERE NOT tombstone;

CREATE TABLE mark (
    document_id    uuid   NOT NULL,
    id_lamport     bigint NOT NULL,
    id_replica     uuid   NOT NULL,
    block_lamport  bigint NOT NULL,
    block_replica  uuid   NOT NULL,
    type           text   NOT NULL,
    attrs          jsonb  NOT NULL DEFAULT '{}'::jsonb,
    start_anchor_l bigint NOT NULL,
    start_anchor_r uuid   NOT NULL,
    start_bias     text   NOT NULL CHECK (start_bias IN ('before','after')),
    end_anchor_l   bigint NOT NULL,
    end_anchor_r   uuid   NOT NULL,
    end_bias       text   NOT NULL CHECK (end_bias IN ('before','after')),
    tombstone      bool   NOT NULL DEFAULT false,
    PRIMARY KEY (document_id, id_lamport, id_replica)
);
CREATE INDEX mark_in_block
    ON mark (document_id, block_lamport, block_replica)
    WHERE NOT tombstone;

-- ─────────────────────── sync state ──────────────────────

-- Per-replica server-side knowledge of what each replica has acknowledged.
-- Used to compute "ops since" deltas and to safely garbage-collect.
CREATE TABLE replica_clock (
    document_id  uuid   NOT NULL,
    replica_id   uuid   NOT NULL,                 -- the replica we're tracking
    seen_replica uuid   NOT NULL,                 -- author of those ops
    seen_lamport bigint NOT NULL,
    PRIMARY KEY (document_id, replica_id, seen_replica)
);

-- ─────────────────────── snapshots / GC ──────────────────

CREATE TABLE snapshot (
    id           uuid PRIMARY KEY,
    document_id  uuid NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    -- Version vector at which this snapshot was taken.
    version      jsonb NOT NULL,
    -- Serialised materialised state; for very large docs this can be a
    -- pointer into object storage instead.
    state        bytea NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now()
);
```

### 3.1 Why both an op log and materialised tables?

- The op log is the **source of truth** and is what the sync protocol
  ships. It is append-only, which is friendly to streaming replication and
  audit.
- The materialised tables let the server answer **read** API requests
  (rendering, search, exports) without replaying the log. They are derived
  state and can be rebuilt; corruption is recoverable.

### 3.2 Garbage collection

Tombstones (`block.tombstone`, `text_char.tombstone`, `mark.tombstone`) and
old log rows can be removed once **every active replica** has acknowledged
ops up to a Lamport watermark. The watermark is `min` over `replica_clock`
for replicas considered "active" (heuristic: `last_seen_at > now() - 30d`).

Older replicas that re-appear are caught up from the most recent
`snapshot` whose `version` ≤ what they've acknowledged. If no such
snapshot exists, they perform a full state download and discard their
local replica.

---

## 4. Operation set

All operations share the envelope:

```json
{
  "kind":      "<see below>",
  "id":        { "lamport": 42, "replica": "…uuid…" },
  "deps":      { "<replica_uuid>": <max_lamport>, … },
  "payload":   { … }
}
```

The kinds:

| Kind            | Payload                                                                           | Purpose                            |
| --------------- | --------------------------------------------------------------------------------- | ---------------------------------- |
| `InsertBlock`   | `{ parent, left, right, type, attrs }`                                            | Add a block as a child of `parent` |
| `MoveBlock`     | `{ block, new_parent, left, right }`                                              | Reparent or reorder a block        |
| `DeleteBlock`   | `{ block }`                                                                       | Tombstone a block subtree          |
| `SetBlockAttr`  | `{ block, key, value }`                                                           | LWW set on `attrs`                 |
| `InsertText`    | `{ block, left, right, chars: [{id, value}, …] }`                                 | Insert chars into a block          |
| `DeleteText`    | `{ block, ids: [op_id, …] }`                                                      | Tombstone chars                    |
| `AddMark`       | `{ block, type, attrs, start, end }`                                              | Apply an inline mark               |
| `RemoveMark`    | `{ block, type, start, end }` (carves)                                            | Remove an inline mark              |
| `SetMarkAttr`   | `{ mark, key, value }`                                                            | LWW set on `mark.attrs`            |

Notes:

- `left` / `right` in block and text inserts are the `OpId`s of neighbours
  observed at insertion time (or the sentinels `BLOCK_START` /
  `BLOCK_END`). They are **origins**, not current positions; they may be
  tombstoned by the time the op arrives at a peer, and that's fine.
- `InsertText` batches a contiguous run of characters typed in one
  keystroke burst; each character still gets its own `OpId`
  (`(id.lamport+i, id.replica)` for the i-th char). Batching is purely a
  wire optimisation.
- `MoveBlock` is a single op (not delete+insert) to preserve identity for
  child references, marks, and history.

---

## 5. API

Two surfaces:

- **REST/HTTPS** for control-plane operations (CRUD on documents, history,
  exports). OpenAPI definition in [`openapi.yaml`](./openapi.yaml).
- **WebSocket** for the live sync protocol described in
  [`sync-protocol.md`](./sync-protocol.md).

### 5.1 REST endpoints

```
POST   /v1/documents                       → create empty document
GET    /v1/documents/{id}                  → metadata
DELETE /v1/documents/{id}                  → delete document (and all replicas)

GET    /v1/documents/{id}/state            → current materialised state (JSON tree)
GET    /v1/documents/{id}/markdown         → rendered Markdown source
GET    /v1/documents/{id}/snapshot/latest  → latest CRDT snapshot (binary)
GET    /v1/documents/{id}/snapshot/{vv}    → snapshot ≥ given version vector

GET    /v1/documents/{id}/ops?since={vv}   → ops newer than the given vv
POST   /v1/documents/{id}/ops              → submit a batch of ops
                                             (idempotent on (lamport, replica))

POST   /v1/documents/{id}/replicas         → register a replica, mint replica_id
DELETE /v1/documents/{id}/replicas/{rid}   → forget a retired replica
```

Auth is out of scope here; assume a bearer token resolved to an actor.
Authorisation enforces `document_id`-level access and is checked on every
endpoint and on every WebSocket frame.

### 5.2 Document state response shape

The server returns the materialised tree, suitable for direct rendering:

```jsonc
{
  "id": "…",
  "version": { "<replica>": <lamport>, … },
  "root": {
    "id": { "lamport": 0, "replica": "…server…" },
    "type": "doc",
    "attrs": {},
    "children": [
      {
        "id": { "lamport": 7, "replica": "alice" },
        "type": "heading",
        "attrs": { "level": 1 },
        "text": "Introduction",
        "marks": []
      },
      {
        "id": { "lamport": 9, "replica": "alice" },
        "type": "paragraph",
        "text": "Hello world",
        "marks": [
          { "type": "strong", "start": 0, "end": 5 }
        ]
      }
    ]
  }
}
```

`text` and `marks` here are flattened for clients that just want to render.
The `start` / `end` mark indices are character offsets in the visible
(non-tombstoned) text. Clients that participate in sync use the raw CRDT
state instead, fetched via snapshots + ops.

### 5.3 WebSocket sync protocol (summary)

Connect: `wss://…/v1/documents/{id}/sync?replica={rid}`

After connect:

1. **Handshake** — client sends `Hello { version_vector }`; server replies
   with `Welcome { version_vector, server_replica_id }`.
2. **Catch-up** — each side sends `OpBatch` frames covering ops the other
   side has not yet seen, computed from the exchanged version vectors.
3. **Live** — both sides forward newly-applied ops as `OpBatch` frames.
   Ops with unmet `deps` are buffered until satisfied.
4. **Presence** — out-of-band `Presence { cursor, selection, label }`
   frames; not part of the CRDT, not persisted.
5. **Ack** — each side periodically sends `Ack { version_vector }` so the
   server can update `replica_clock` and advance the GC watermark.

Full framing in [`sync-protocol.md`](./sync-protocol.md).

---

## 6. Worked example

A full trace of two replicas (Alice + Bob) editing the same document — with
every API call, WebSocket frame, and database row — lives in
[`example-edit-flow.md`](./example-edit-flow.md). What follows here is the
short Peritext-bias illustration.

### 6.1 Mark bias on trailing input

Two replicas, `A` and `B`, both observe a paragraph containing `"Hi"` (chars
`h@(1,A)`, `i@(2,A)`).

Concurrently:

- `A` types `!` after `i`: `InsertText { block, left=(2,A), right=END,
  chars=[{id:(3,A), value:"!"}] }`.
- `B` bolds the whole paragraph: `AddMark { block, type:'strong',
  start:{anchor:(1,A), bias:'before'},
  end:{anchor:(2,A), bias:'after'} }`.

After exchange:

- The text sequence integrates `!` to the right of `i` (only one origin
  pair, no conflicts).
- The mark's `end` anchor is `(2,A)` with `bias='after'`. Inserts whose
  `left_origin` is `(2,A)` land **inside** the mark's right boundary, so
  `!` inherits bold. This is the Peritext "after" bias and the standard
  expected behaviour for trailing input on a bold run.

Had `B` instead set `end.bias = 'before'`, `!` would land outside the
mark and remain unbolded. This is how clients implement "stop bold on the
right edge" vs "keep bold on the right edge" without a coordination round
trip.

---

## 7. Open questions

- **Tables** are modelled as nested blocks (`table > table_row >
  table_cell`). Concurrent column adds across rows are correct by
  construction (each row is an independent list CRDT) but the resulting
  geometry can be ragged. We accept ragged tables; renderers pad with
  empty cells. A future op `EnsureColumnCount` could normalise.
- **Code block content** currently ignores marks. We may want a separate
  block type for inline-code-only segments to keep code blocks pure text.
- **Large pastes** (≫ 10⁴ chars) blow up the op log. A `BulkInsert` op
  carrying a packed run with shared origins could be considered later, but
  it complicates the tie-break rules and is deferred.
- **Server authorship**: the server occasionally authors ops (e.g. GC,
  schema migration). We mint a stable `replica_id` for the server per
  document so those ops are causally ordered like any other.
