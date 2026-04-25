# MarkCRDT

A Conflict-Free Replicated Data Type for collaborative Markdown editing.

MarkCRDT models a Markdown document as a **tree of blocks** (paragraphs,
headings, lists, code blocks, …) where:

- block ordering and nesting are captured by a list/tree CRDT,
- text inside each block is captured by a sequence CRDT,
- inline formatting (bold, italic, link, …) is captured by a Peritext-style
  mark CRDT keyed on stable text positions.

The repository currently contains the design only. See
[`docs/DESIGN.md`](docs/DESIGN.md) for the full data model, database schema,
operation set, and synchronization API.

## Layout

```
docs/
  DESIGN.md       – overall design (this document is the source of truth)
  schema.sql      – reference PostgreSQL schema
  openapi.yaml    – REST surface
  sync-protocol.md– WebSocket sync protocol
```
