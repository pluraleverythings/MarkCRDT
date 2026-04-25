-- MarkCRDT reference schema (PostgreSQL ≥ 14).
--
-- Types:
--   OpId          := (lamport bigint, replica_id uuid)
--   VersionVector := jsonb of { replica_id (uuid as text) → max_lamport (bigint) }
--   Position      := bytea, materialised list-CRDT order key (variable length)
--
-- Conventions:
--   – All FKs are document-scoped; cascading deletes only the document level.
--   – `tombstone` columns are kept until GC has confirmed every active
--     replica has acknowledged the deletion.

-- ──────────────────────────── identities ────────────────────────────────

CREATE TABLE document (
    id             uuid        PRIMARY KEY,
    created_at     timestamptz NOT NULL DEFAULT now(),
    server_lamport bigint      NOT NULL DEFAULT 0,
    head_snapshot  uuid        NULL
);

CREATE TABLE replica (
    id           uuid        PRIMARY KEY,
    document_id  uuid        NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    label        text        NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX replica_by_document ON replica (document_id);

-- ──────────────────────────── op log ────────────────────────────────────

CREATE TABLE op (
    document_id uuid        NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    lamport     bigint      NOT NULL,
    replica_id  uuid        NOT NULL,
    kind        text        NOT NULL,
    deps        jsonb       NOT NULL,
    payload     jsonb       NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, lamport, replica_id)
);
CREATE INDEX op_by_replica ON op (document_id, replica_id, lamport);

-- ──────────────────────────── materialised state ────────────────────────

CREATE TABLE block (
    document_id    uuid   NOT NULL,
    id_lamport     bigint NOT NULL,
    id_replica     uuid   NOT NULL,
    parent_lamport bigint NULL,
    parent_replica uuid   NULL,
    type           text   NOT NULL,
    attrs          jsonb  NOT NULL DEFAULT '{}'::jsonb,
    position       bytea  NOT NULL,
    tombstone      bool   NOT NULL DEFAULT false,
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
    value         text   NOT NULL,
    left_lamport  bigint NULL,
    left_replica  uuid   NULL,
    right_lamport bigint NULL,
    right_replica uuid   NULL,
    position      bytea  NOT NULL,
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

-- ──────────────────────────── sync state ────────────────────────────────

CREATE TABLE replica_clock (
    document_id  uuid   NOT NULL,
    replica_id   uuid   NOT NULL,
    seen_replica uuid   NOT NULL,
    seen_lamport bigint NOT NULL,
    PRIMARY KEY (document_id, replica_id, seen_replica)
);

-- ──────────────────────────── snapshots ─────────────────────────────────

CREATE TABLE snapshot (
    id          uuid        PRIMARY KEY,
    document_id uuid        NOT NULL REFERENCES document(id) ON DELETE CASCADE,
    version     jsonb       NOT NULL,
    state       bytea       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snapshot_by_document ON snapshot (document_id, created_at DESC);
