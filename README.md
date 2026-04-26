# MarkCRDT

A Conflict-Free Replicated Data Type for collaborative rich-text editing
based on the [Peritext paper](https://www.inkandswitch.com/peritext/),
plus a sync server.

## Packages

- [`@markcrdt/core`](packages/core) — the CRDT itself (Peritext sequence +
  marks, plus a comment-management layer with threads/resolve/persistence).
  Pure TypeScript, no I/O.
- [`@markcrdt/server`](packages/server) — HTTP + WebSocket sync server,
  Postgres-backed op log, snapshot optimisation.

## Layout

```
packages/
  core/
    src/             # Peritext, CommentStore, CommentManager
    test/            # 25 tests
    examples/walkthrough.ts
  server/
    src/             # Fastify app, HTTP + WS, storage adapters
    schema.sql       # Postgres schema
    test/            # 10 integration tests (HTTP + WS + snapshots)
```

## Develop

```bash
npm install
npm test           # runs both packages' test suites
npm --workspace @markcrdt/core run build
npm --workspace @markcrdt/server run build
```

## Run the server locally

```bash
node packages/server/dist/main.js              # in-memory storage
DATABASE_URL=postgres://… node …/main.js      # Postgres
```

See [`packages/server/README.md`](packages/server/README.md) for the
HTTP / WS protocol and architecture.
