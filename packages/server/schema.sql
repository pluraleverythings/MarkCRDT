-- MarkCRDT server schema (Postgres).
--
-- The op log is the source of truth. Snapshots are an optimisation so a
-- new client doesn't replay millions of ops on bootstrap.

CREATE TABLE IF NOT EXISTS document (
  id          UUID PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only op log. Idempotent insert by primary key.
-- `seq` is a per-row server-assigned ordinal so we can return ops in
-- arrival order without trusting the client clock.
CREATE TABLE IF NOT EXISTS op (
  doc_id      UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  layer       TEXT NOT NULL,           -- 'peritext' | 'comment'
  op_node     TEXT NOT NULL,
  op_counter  BIGINT NOT NULL,
  seq         BIGSERIAL,
  payload     JSONB NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, layer, op_node, op_counter)
);

CREATE INDEX IF NOT EXISTS op_by_doc_seq ON op (doc_id, seq);
CREATE INDEX IF NOT EXISTS op_by_doc_node_counter ON op (doc_id, op_node, op_counter);

-- Latest-wins snapshot per doc. We keep history (one row per snapshot)
-- so we can roll back if needed; queries fetch the highest taken_at.
CREATE TABLE IF NOT EXISTS snapshot (
  doc_id          UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  version_vector  JSONB NOT NULL,
  state           JSONB NOT NULL,
  PRIMARY KEY (doc_id, taken_at)
);

CREATE INDEX IF NOT EXISTS snapshot_latest ON snapshot (doc_id, taken_at DESC);

-- Users + membership.
--
-- "app_user" rather than "user" to avoid Postgres's reserved word.
-- Membership is a simple ACL: a row grants a user a role on a document.
-- Role values are kept inline (CHECK constraint) rather than a separate
-- enum so adding a role doesn't need a migration on every shard.

CREATE TABLE IF NOT EXISTS app_user (
  id            UUID PRIMARY KEY,
  handle        TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_member (
  doc_id    UUID NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, user_id)
);

CREATE INDEX IF NOT EXISTS document_member_by_user
  ON document_member (user_id, added_at DESC);
