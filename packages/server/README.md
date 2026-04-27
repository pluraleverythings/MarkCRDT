# @markcrdt/server

Sync server for MarkCRDT — HTTP + WebSocket + Postgres + snapshots.

The server is a thin orchestration layer over an append-only op log. It
does **not** decide who wins on concurrent edits; convergence is handled
by the CRDT in `@markcrdt/core`. The server's jobs are durability,
fan-out, and bootstrap optimisation.

## Quick start

```bash
npm install
npm --workspace @markcrdt/server run build

# In-memory (dev only — no durability):
node packages/server/dist/main.js

# Postgres-backed:
psql "$DATABASE_URL" -f packages/server/schema.sql
DATABASE_URL=postgres://user:pass@host/db \
  PORT=8080 \
  SNAPSHOT_EVERY_OPS=200 \
  node packages/server/dist/main.js
```

## HTTP API

### Documents

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/documents` | `{ ownerId? }` | `DocMeta` |
| `GET` | `/documents` | `?limit=N` | `DocMeta[]` |
| `GET` | `/documents/:id` | — | `DocMeta` |
| `GET` | `/documents/:id/state` | `?vv=<base64-json>` | `{ vv, snapshot?, ops }` |
| `POST` | `/documents/:id/ops` | `{ ops: OpEnvelope[] }` | `{ accepted, vv }` |

### Users

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `POST` | `/users` | `{ handle, displayName? }` | `User` (409 if handle taken) |
| `GET` | `/users` | `?handle=H` *or* `?limit=N` | `User[]` |
| `GET` | `/users/:id` | — | `User` |
| `DELETE` | `/users/:id` | — | `204` (cascades to memberships) |
| `POST` | `/users/:id/documents` | — | `DocMeta` (user is owner) |
| `GET` | `/users/:id/documents` | `?limit=N` | `DocMeta[]` (every doc the user is a member of) |

### Membership

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/documents/:id/members` | — | `DocMember[]` |
| `PUT` | `/documents/:id/members/:userId` | `{ role: "owner"\|"editor"\|"viewer" }` | `DocMember` (upserts) |
| `DELETE` | `/documents/:id/members/:userId` | — | `204` |

> The HTTP layer **does not enforce authorization** — it provides the
> data primitives (users, membership, roles) that an auth middleware
> would gate on. Drop a `preHandler` hook on the `/documents/*` routes to
> check `getMember(docId, currentUserId)` against the required role.

`OpEnvelope` shape:

```ts
{ docId: string, layer: "peritext" | "comment", payload: <core op> }
```

The `payload` is exactly what the core library produces (`Peritext.insert`,
`CommentManager.create` etc. all return ops). The server inspects only
`payload.opId.{counter,node}` for dedupe and version-vector tracking.

## WebSocket sync

```
GET ws://host/documents/:id/sync
```

Frames are JSON.

**Client → Server**

```ts
{ t: "hello", clientId: string, vv: VersionVector }
{ t: "ops",   ops: OpEnvelope[] }
{ t: "ping" }
```

**Server → Client**

```ts
{ t: "welcome", clientId, vv, snapshot?, ops }
{ t: "ops",     ops }
{ t: "ack",     vv }
{ t: "error",   code, message }
{ t: "pong" }
```

The server tracks each connection's effective version vector internally
so it never echoes a client's own ops back.

## Snapshots

Every `SNAPSHOT_EVERY_OPS` accepted ops, the server replays the doc's op
log through `@markcrdt/core` to materialise text + formatted runs +
comments and writes a snapshot row. New clients connecting with an empty
version vector receive `snapshot + ops since snapshot` instead of the
full log — bounded bootstrap cost regardless of doc age.

You can also force a snapshot at any time:

```ts
import { Snapshotter, PostgresStorage } from "@markcrdt/server";
await new Snapshotter(storage, 1).takeSnapshot(docId);
```

## Storage interfaces

`Storage` (in `src/storage.ts`) is the only contract. Two implementations
ship:

- `MemoryStorage` — process-local, for tests and local dev.
- `PostgresStorage` — production. Schema in `schema.sql`. Uses idempotent
  `INSERT ... ON CONFLICT DO NOTHING` with `RETURNING` to detect newly
  accepted ops.

To scale fan-out across multiple server instances, layer Redis pub/sub
on top of `DocService.subscribe` — the seam is intentional.

## Architecture sketch

```
        ┌──────────┐ POST /documents/:id/ops      ┌──────────────┐
client ─┤  HTTP    ├─────────────────────────────▶│              │
        │          │ GET  /documents/:id/state    │              │
        └──────────┘                              │              │
                                                  │  DocService  │
        ┌──────────┐ {hello, ops, ack, …}         │              │
client ─┤    WS    │◀────────────────────────────▶│  ┌────────┐  │
        └──────────┘                              │  │subs map│  │
                                                  │  └────────┘  │
                                                  └──────┬───────┘
                                                         │
                                              ┌──────────▼──────────┐
                                              │      Storage        │
                                              │ (Memory | Postgres) │
                                              └──────────┬──────────┘
                                                         │
                                                ┌────────▼────────┐
                                                │   Snapshotter   │
                                                │ replays through │
                                                │ @markcrdt/core  │
                                                └─────────────────┘
```
