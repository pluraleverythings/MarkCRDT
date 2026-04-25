# MarkCRDT — Sync Protocol

A WebSocket-based, frame-oriented protocol for replicating MarkCRDT
documents. Both peers (client ↔ server, or peer-to-peer) speak the same
protocol; this document uses "client" and "server" only for concreteness.

## 1. Connection

```
GET wss://api.markcrdt.example/v1/documents/{document_id}/sync?replica={replica_id}
Authorization: Bearer <token>
Sec-WebSocket-Protocol: markcrdt.v1
```

The server rejects the upgrade if the bearer token does not authorise
access to `document_id` or if `replica_id` is not registered for that
document.

Frames are JSON (UTF-8) on the text channel. Binary frames are reserved for
future snapshot streaming.

## 2. Frames

Every frame has `{ "t": "<frame_type>", … }`. Other fields depend on `t`.

### 2.1 `Hello` (client → server, first frame)

```json
{
  "t":  "Hello",
  "vv": { "<replica_uuid>": <max_lamport>, … },
  "client": { "name": "markcrdt-web", "version": "0.1.0" }
}
```

`vv` is the client's current version vector — what it has already
integrated. The server uses it to compute the catch-up batch.

### 2.2 `Welcome` (server → client, response to `Hello`)

```json
{
  "t":  "Welcome",
  "vv": { … },
  "server_replica": "<uuid>",
  "snapshot_hint": { "id": "<uuid>", "version": { … } }
}
```

`snapshot_hint` is optional. The server includes it when the gap between
the client's `vv` and the server's `vv` is larger than a threshold; the
client is then expected to fetch that snapshot via REST and replay
remaining ops on top of it. This avoids streaming millions of historical
ops over the WebSocket.

### 2.3 `OpBatch` (both directions)

```json
{
  "t":  "OpBatch",
  "ops": [ { …Op…  }, … ]
}
```

Receiver behaviour:

1. For each op in arrival order, check that every entry in `op.deps` is ≤
   the receiver's current `vv` for that replica.
2. If yes, apply the op (idempotent on `(lamport, replica)` — duplicates
   are dropped) and bump `vv`.
3. If no, park the op in a buffer keyed by missing `(replica, lamport)`.
   When a satisfying op later arrives, drain the buffer.

Senders should send ops in causal order whenever convenient (it lets the
receiver skip the buffer). Causal order is not required for correctness.

### 2.4 `Ack` (both directions, periodic)

```json
{
  "t":  "Ack",
  "vv": { … }
}
```

Sent at most every `T_ack` seconds (default 5s) and immediately when an
`OpBatch` brings the local `vv` up to or past a previously-seen "high
water mark". The server uses incoming `Ack`s to update the
`replica_clock` table, which in turn drives garbage collection.

### 2.5 `Presence` (both directions, ephemeral)

```json
{
  "t": "Presence",
  "user": { "id": "<actor>", "label": "Alice", "color": "#ff8800" },
  "cursor": {
    "block":  { "lamport": 9, "replica": "alice" },
    "anchor": { "lamport": 12, "replica": "alice", "bias": "after" },
    "head":   { "lamport": 18, "replica": "alice", "bias": "before" }
  }
}
```

Not persisted, not part of the CRDT, not subject to causality. The server
fans presence out to other connected replicas of the same document.

A peer that has gone idle is conveyed by absence: if no `Presence` frame
arrives for `T_presence_idle` (default 30s) the peer is considered idle
and renderers should hide the cursor.

### 2.6 `Bye` (either direction)

```json
{ "t": "Bye", "reason": "shutdown" }
```

Optional graceful close. The server treats a missing `Bye` followed by a
TCP close as identical.

### 2.7 `Error` (server → client)

```json
{ "t": "Error", "code": "causal_gap", "message": "…", "fatal": false }
```

| Code               | Fatal | Meaning                                                         |
| ------------------ | :---: | --------------------------------------------------------------- |
| `causal_gap`       |  no   | Buffer overflow on parked ops; client should reconnect with vv. |
| `replica_unknown`  |  yes  | The `replica_id` is not registered.                             |
| `auth_expired`     |  yes  | Bearer token expired; re-auth and reconnect.                    |
| `version_too_old`  |  no   | Client `vv` is older than oldest snapshot; full reload needed.  |
| `rate_limited`     |  no   | Back off and retry.                                             |

## 3. Flow

```
Client                                 Server
  |── Hello(vv_c) ─────────────────────>|
  |<──────────────────── Welcome(vv_s) ─|
  |<──────────── OpBatch(server → client)
  |── OpBatch(client → server) ────────>|
  |<──────────────────── Ack(vv_s) ─────|
  |── Ack(vv_c) ───────────────────────>|
  |     … steady-state OpBatch / Ack …
  |── Presence … ──────────────────────>|
  |<── Presence … ───────────────────────
```

After `Welcome`, both sides immediately stream the ops the other does not
have. Once both `vv`s are equal, the connection is "live" and only carries
new ops, acks, and presence.

## 4. Reconnection

A client that disconnects and reconnects re-runs the handshake with its
current `vv`. Because op apply is idempotent on `(lamport, replica)`,
double delivery is harmless. The server must not assume that a client
which acknowledged `vv` has retained it across disconnects — clients that
lost state advertise the lower `vv` they actually have, and the server
re-streams the gap.

If the gap is larger than `MAX_OP_GAP` (default 50_000 ops), the server
returns `Welcome` with a `snapshot_hint` instead of streaming the gap, and
the client switches to snapshot-then-tail.

## 5. Sizing

- Default frame max: 256 KiB. `OpBatch`es larger than this are split.
- Default `T_ack`: 5 s.
- Default `T_presence_idle`: 30 s.
- Server drops idle connections after 60 s without any frame; clients
  send a zero-op `OpBatch` or an `Ack` as keep-alive.
