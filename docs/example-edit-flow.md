# MarkCRDT — Worked Edit Flow

A concrete trace of two replicas editing a document, showing every API
call, every WebSocket frame, and every database row that gets written or
read on the server. Op-IDs use the shorthand `(lamport, replica_short)`
where replicas are `S` (server), `A` (Alice), `B` (Bob).

---

## 0. Cast and shorthand

```
Alice  replica_id = a1111111-…  → A
Bob    replica_id = b2222222-…  → B
Server replica_id = ssssssss-…  → S        (used for server-authored ops)

doc_id = d0000000-0000-0000-0000-000000000000
```

Sentinels: `BLOCK_START` and `BLOCK_END` are well-known constants used as
origins for the very first / very last position in a block.

---

## 1. Alice creates the document

### 1.1 HTTP

```http
POST /v1/documents
Authorization: Bearer …alice…
```

### 1.2 Server work

```sql
-- 1. Mint document.
INSERT INTO document (id, server_lamport)
VALUES ('d0000000-…', 1);

-- 2. Register the server replica for this document.
INSERT INTO replica (id, document_id, label)
VALUES ('ssssssss-…', 'd0000000-…', 'server');

-- 3. Author the root block as a single op.
INSERT INTO op (document_id, lamport, replica_id, kind, deps, payload)
VALUES ('d0000000-…', 1, 'ssssssss-…', 'InsertBlock',
        '{}'::jsonb,
        '{"parent": null, "left": null, "right": null,
          "type": "doc", "attrs": {}}'::jsonb);

-- 4. Materialise it.
INSERT INTO block (document_id, id_lamport, id_replica,
                   parent_lamport, parent_replica,
                   type, attrs, position, tombstone)
VALUES ('d0000000-…', 1, 'ssssssss-…',
        NULL, NULL,
        'doc', '{}'::jsonb, '\x80'::bytea, false);
```

### 1.3 HTTP response

```json
201 Created
{ "id": "d0000000-…",
  "created_at": "2026-04-25T10:00:00Z",
  "version": { "ssssssss-…": 1 } }
```

---

## 2. Alice registers her replica

### 2.1 HTTP

```http
POST /v1/documents/d0000000-…/replicas
Content-Type: application/json

{ "label": "alice@laptop" }
```

### 2.2 Server work

```sql
INSERT INTO replica (id, document_id, label)
VALUES ('a1111111-…', 'd0000000-…', 'alice@laptop');
```

### 2.3 HTTP response

```json
201 Created
{ "id": "a1111111-…",
  "document_id": "d0000000-…",
  "label": "alice@laptop",
  "last_seen_at": "2026-04-25T10:00:01Z" }
```

---

## 3. Alice opens the WebSocket

```
GET wss://…/v1/documents/d0000000-…/sync?replica=a1111111-…
```

### 3.1 Alice → Server

```json
{ "t": "Hello", "vv": {}, "client": { "name": "markcrdt-web", "version": "0.1.0" } }
```

### 3.2 Server work — compute catch-up

```sql
-- Find ops Alice doesn't have yet (her vv is empty → everything).
SELECT lamport, replica_id, kind, deps, payload
FROM   op
WHERE  document_id = 'd0000000-…'
ORDER  BY lamport, replica_id;
-- → 1 row: the root InsertBlock authored by S.

-- Server's own vv:
SELECT replica_id, max(lamport) AS hi
FROM   op
WHERE  document_id = 'd0000000-…'
GROUP  BY replica_id;
-- → { S: 1 }
```

### 3.3 Server → Alice

```json
{ "t": "Welcome",
  "vv": { "ssssssss-…": 1 },
  "server_replica": "ssssssss-…" }
```

```json
{ "t": "OpBatch",
  "ops": [
    { "kind": "InsertBlock",
      "id":   { "lamport": 1, "replica": "ssssssss-…" },
      "deps": {},
      "payload": { "parent": null, "left": null, "right": null,
                   "type": "doc", "attrs": {} } }
  ] }
```

### 3.4 Alice → Server

```json
{ "t": "Ack", "vv": { "ssssssss-…": 1 } }
```

### 3.5 Server work — record the ack

```sql
INSERT INTO replica_clock (document_id, replica_id, seen_replica, seen_lamport)
VALUES ('d0000000-…', 'a1111111-…', 'ssssssss-…', 1)
ON CONFLICT (document_id, replica_id, seen_replica)
DO UPDATE SET seen_lamport = GREATEST(replica_clock.seen_lamport, EXCLUDED.seen_lamport);
```

---

## 4. Alice types "Hi" in a new paragraph

Alice's editor produces three ops locally before sending. Her Lamport clock
walks `1 → 2 → 3` (the InsertText op consumes Lamport for both its char
ids).

```
op_A1: InsertBlock  id=(1,A)  deps={S:1}
       payload = { parent: (1,S), left: BLOCK_START, right: BLOCK_END,
                   type: "paragraph", attrs: {} }

op_A2: InsertText   id=(2,A)  deps={S:1, A:1}
       payload = { block: (1,A),
                   left: BLOCK_START, right: BLOCK_END,
                   chars: [ { id: (2,A), value: "H" },
                            { id: (3,A), value: "i" } ] }
```

### 4.1 Alice → Server

```json
{ "t": "OpBatch", "ops": [
  { "kind": "InsertBlock",
    "id":   { "lamport": 1, "replica": "a1111111-…" },
    "deps": { "ssssssss-…": 1 },
    "payload": {
      "parent": { "lamport": 1, "replica": "ssssssss-…" },
      "left": "BLOCK_START", "right": "BLOCK_END",
      "type": "paragraph", "attrs": {} } },

  { "kind": "InsertText",
    "id":   { "lamport": 2, "replica": "a1111111-…" },
    "deps": { "ssssssss-…": 1, "a1111111-…": 1 },
    "payload": {
      "block": { "lamport": 1, "replica": "a1111111-…" },
      "left": "BLOCK_START", "right": "BLOCK_END",
      "chars": [
        { "id": { "lamport": 2, "replica": "a1111111-…" }, "value": "H" },
        { "id": { "lamport": 3, "replica": "a1111111-…" }, "value": "i" }
      ] } }
] }
```

### 4.2 Server work

For each op in arrival order: verify `deps ≤ server_vv`, append to log,
update materialised state, advance `server_vv`.

```sql
-- op_A1 — append to log
INSERT INTO op (document_id, lamport, replica_id, kind, deps, payload) VALUES
  ('d0000000-…', 1, 'a1111111-…', 'InsertBlock',
   '{"ssssssss-…":1}'::jsonb,
   '{"parent":{"lamport":1,"replica":"ssssssss-…"},
     "left":"BLOCK_START","right":"BLOCK_END",
     "type":"paragraph","attrs":{}}'::jsonb);

-- op_A1 — materialise block; `position` computed by the list-CRDT
-- positional algorithm against the parent's existing children (none here).
INSERT INTO block VALUES
  ('d0000000-…', 1, 'a1111111-…',          -- id
   1, 'ssssssss-…',                         -- parent (= root)
   'paragraph', '{}'::jsonb,
   '\x80'::bytea, false);                   -- position, tombstone

-- op_A2 — append to log
INSERT INTO op (document_id, lamport, replica_id, kind, deps, payload) VALUES
  ('d0000000-…', 2, 'a1111111-…', 'InsertText',
   '{"ssssssss-…":1,"a1111111-…":1}'::jsonb,
   '{"block":{"lamport":1,"replica":"a1111111-…"},
     "left":"BLOCK_START","right":"BLOCK_END",
     "chars":[{"id":{"lamport":2,"replica":"a1111111-…"},"value":"H"},
              {"id":{"lamport":3,"replica":"a1111111-…"},"value":"i"}]}'::jsonb);

-- op_A2 — materialise both characters.
-- Server reads the existing chars in the block to compute order keys:
SELECT id_lamport, id_replica, position
FROM   text_char
WHERE  document_id   = 'd0000000-…'
  AND  block_lamport = 1
  AND  block_replica = 'a1111111-…'
  AND  NOT tombstone
ORDER  BY position;
-- → 0 rows (block was just created).

INSERT INTO text_char VALUES
  ('d0000000-…', 1, 'a1111111-…',           -- block id
   2, 'a1111111-…',                          -- char id
   'H', NULL, NULL, NULL, NULL,              -- value, left/right origins
   '\x40'::bytea, false),
  ('d0000000-…', 1, 'a1111111-…',
   3, 'a1111111-…',
   'i', 2, 'a1111111-…', NULL, NULL,
   '\x60'::bytea, false);
```

Server vv is now `{ S: 1, A: 3 }`. The server fans these ops out to all
other live WebSocket subscribers (none yet).

### 4.3 Server → Alice

```json
{ "t": "Ack", "vv": { "ssssssss-…": 1, "a1111111-…": 3 } }
```

---

## 5. Bob joins and bootstraps via REST

Bob has never seen the doc. He registers as a replica, then asks for the
materialised state to render an initial UI before opening the WebSocket.

### 5.1 HTTP — register replica

```http
POST /v1/documents/d0000000-…/replicas
{ "label": "bob@phone" }
```

```sql
INSERT INTO replica (id, document_id, label)
VALUES ('b2222222-…', 'd0000000-…', 'bob@phone');
```

### 5.2 HTTP — fetch state

```http
GET /v1/documents/d0000000-…/state
```

Server reads:

```sql
-- Document version vector.
SELECT replica_id, max(lamport) FROM op
WHERE document_id='d0000000-…' GROUP BY replica_id;
-- → { S:1, A:3 }

-- Block tree (recursive walk from root).
SELECT id_lamport, id_replica, parent_lamport, parent_replica,
       type, attrs, position
FROM   block
WHERE  document_id='d0000000-…' AND NOT tombstone
ORDER  BY parent_lamport, parent_replica, position;

-- Text per leaf block.
SELECT block_lamport, block_replica, id_lamport, id_replica,
       value, position
FROM   text_char
WHERE  document_id='d0000000-…' AND NOT tombstone
ORDER  BY block_lamport, block_replica, position;

-- Marks per block.
SELECT … FROM mark
WHERE  document_id='d0000000-…' AND NOT tombstone;
-- → 0 rows.
```

Response:

```json
200 OK
{ "id": "d0000000-…",
  "version": { "ssssssss-…": 1, "a1111111-…": 3 },
  "root": {
    "id": { "lamport": 1, "replica": "ssssssss-…" },
    "type": "doc",
    "children": [
      { "id":   { "lamport": 1, "replica": "a1111111-…" },
        "type": "paragraph",
        "text": "Hi",
        "marks": [] }
    ]
  } }
```

### 5.3 Bob opens the WebSocket

```json
→ { "t": "Hello", "vv": {} }
← { "t": "Welcome", "vv": { "ssssssss-…":1, "a1111111-…":3 },
                   "server_replica": "ssssssss-…" }
← { "t": "OpBatch", "ops": [ /* the 3 ops above, in causal order */ ] }
→ { "t": "Ack", "vv": { "ssssssss-…":1, "a1111111-…":3 } }
```

```sql
INSERT INTO replica_clock VALUES
  ('d0000000-…', 'b2222222-…', 'ssssssss-…', 1),
  ('d0000000-…', 'b2222222-…', 'a1111111-…', 3)
ON CONFLICT … DO UPDATE SET seen_lamport = GREATEST(…);
```

Both replicas now share `vv = { S:1, A:3 }`.

---

## 6. Concurrent edit

At the same wall-clock instant:

- **Alice** appends a space at the end of the paragraph.
- **Bob** bolds the word "Hi".

Neither has seen the other's op when authoring. The two ops are causally
**concurrent**.

```
op_A3: InsertText   id=(4,A)  deps={S:1, A:3}
       payload = { block: (1,A),
                   left: (3,A), right: BLOCK_END,
                   chars: [ { id: (4,A), value: " " } ] }

op_B1: AddMark      id=(1,B)  deps={S:1, A:3}
       payload = { block: (1,A), type: "strong", attrs: {},
                   start: { anchor: (2,A), bias: "before" },
                   end:   { anchor: (3,A), bias: "after"  } }
```

### 6.1 Server receives Alice's frame first

```json
→ { "t": "OpBatch", "ops": [ op_A3 ] }
```

```sql
-- Append.
INSERT INTO op VALUES
  ('d0000000-…', 4, 'a1111111-…', 'InsertText',
   '{"ssssssss-…":1,"a1111111-…":3}'::jsonb,
   '{"block":{"lamport":1,"replica":"a1111111-…"},
     "left":{"lamport":3,"replica":"a1111111-…"},
     "right":"BLOCK_END",
     "chars":[{"id":{"lamport":4,"replica":"a1111111-…"},"value":" "}]}'::jsonb);

-- Compute order key against existing chars in the block.
SELECT id_lamport, id_replica, position FROM text_char
WHERE  document_id='d0000000-…'
  AND  block_lamport=1 AND block_replica='a1111111-…'
  AND  NOT tombstone
ORDER  BY position;
-- → ('H', \x40), ('i', \x60).

INSERT INTO text_char VALUES
  ('d0000000-…', 1, 'a1111111-…',
   4, 'a1111111-…',
   ' ', 3, 'a1111111-…', NULL, NULL,
   '\x70'::bytea, false);   -- between \x60 and end
```

Server fans `op_A3` out to Bob over his WebSocket.

### 6.2 Server receives Bob's frame

```json
→ { "t": "OpBatch", "ops": [ op_B1 ] }
```

`op_B1.deps = { S:1, A:3 }`. Server vv is currently `{ S:1, A:4, B:0 }`,
which dominates the deps — apply.

```sql
INSERT INTO op VALUES
  ('d0000000-…', 1, 'b2222222-…', 'AddMark',
   '{"ssssssss-…":1,"a1111111-…":3}'::jsonb,
   '{"block":{"lamport":1,"replica":"a1111111-…"},
     "type":"strong","attrs":{},
     "start":{"anchor":{"lamport":2,"replica":"a1111111-…"},"bias":"before"},
     "end":  {"anchor":{"lamport":3,"replica":"a1111111-…"},"bias":"after"}}'::jsonb);

-- Materialise.
INSERT INTO mark VALUES
  ('d0000000-…', 1, 'b2222222-…',                 -- mark id
   1, 'a1111111-…',                                -- block id
   'strong', '{}'::jsonb,
   2, 'a1111111-…', 'before',                      -- start anchor
   3, 'a1111111-…', 'after',                       -- end anchor
   false);
```

Server fans `op_B1` out to Alice.

### 6.3 Bob receives `op_A3`

Bob's local vv was `{ S:1, A:3, B:1 }` (he authored op_B1). `op_A3.deps =
{ S:1, A:3 }` is satisfied. He applies:

- text run becomes `H · i · ' '`
- mark on the run is `strong`, anchored on (2,A) and (3,A)
- because `end.bias = 'after'` and the new char has `left=(3,A)`, the new
  char lands inside the right boundary → " " inherits **strong**

Visible state: `**Hi **` (i.e. `Hi ` all bold).

> If Bob had instead created the mark with `end.bias = 'before'`, the
> boundary would have been "to the left of (3,A)" — meaning new chars
> inserted at `left=(3,A)` would land **outside** the mark, and " "
> would not be bold.

### 6.4 Alice receives `op_B1`

Alice's vv was `{ S:1, A:4 }`. `op_B1.deps = { S:1, A:3 }` is satisfied.
She applies the mark, anchors point at characters she still has, result
matches Bob's. Convergence.

### 6.5 Acks

Both clients send `Ack { S:1, A:4, B:1 }`. Server updates `replica_clock`
for both. Once `min` over `replica_clock` reaches `{ S:1, A:4, B:1 }` for
all *active* replicas, GC may compact ops up to that watermark.

---

## 7. Final database state

```
op rows (5 total)
  (S,1) InsertBlock   parent=null, type=doc
  (A,1) InsertBlock   parent=(S,1), type=paragraph
  (A,2) InsertText    block=(A,1), chars=[H@(A,2), i@(A,3)]
  (A,4) InsertText    block=(A,1), chars=[' '@(A,4)]
  (B,1) AddMark       block=(A,1), strong, [(A,2)before .. (A,3)after]

block rows (2)
  (S,1) doc
  (A,1) paragraph     parent=(S,1)

text_char rows (3, all visible)
  (A,2) "H"
  (A,3) "i"
  (A,4) " "

mark rows (1)
  (B,1) strong on block (A,1), anchors (A,2)before .. (A,3)after

replica_clock (assuming both acked through {S:1, A:4, B:1})
  (A → S:1, A:4, B:1)
  (B → S:1, A:4, B:1)
```

Rendered as Markdown via `GET /v1/documents/{id}/markdown`:

```
**Hi **
```

(with the trailing space inside the strong run, per the chosen bias).

---

## 8. What this trace illustrates

- **Append-only `op`** is the source of truth; every authored change is
  one row, idempotent on `(lamport, replica)`.
- **Materialised tables** (`block`, `text_char`, `mark`) are derived and
  let `GET /state` answer in one walk, no log replay.
- **Causal delivery** is enforced by `deps`. Concurrent ops are accepted
  in any order; the server doesn't serialise authors.
- **REST is for bootstrap and exports**; the WebSocket carries the live
  edit stream. Either path can submit ops (`POST /ops`) when the
  WebSocket is unavailable.
- **Convergence with no coordination**: Alice and Bob both reach the
  same final state from concurrent ops, and the Peritext bias on the
  mark's `end` anchor decides whether trailing input inherits formatting.
