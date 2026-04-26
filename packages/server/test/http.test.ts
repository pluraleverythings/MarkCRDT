import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommentManager, CommentStore, Peritext } from "@markcrdt/core";
import type { App } from "../src/index.js";
import { buildApp, MemoryStorage, type OpEnvelope } from "../src/index.js";

let app: App;

beforeAll(async () => {
  app = await buildApp({ storage: new MemoryStorage(), snapshotEvery: 1000 });
});

afterAll(async () => {
  await app.fastify.close();
});

describe("HTTP API", () => {
  it("creates, lists, and fetches docs", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: "/documents",
    });
    expect(created.statusCode).toBe(200);
    const meta = created.json() as { id: string };
    expect(meta.id).toMatch(/-/);

    const got = await app.fastify.inject({
      method: "GET",
      url: `/documents/${meta.id}`,
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: meta.id });

    const list = await app.fastify.inject({
      method: "GET",
      url: "/documents?limit=10",
    });
    expect(list.statusCode).toBe(200);
    const docs = list.json() as { id: string }[];
    expect(docs.find((d) => d.id === meta.id)).toBeDefined();
  });

  it("submits ops over REST and replays them on a fresh client", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: "/documents",
    });
    const { id: docId } = created.json() as { id: string };

    // Author some ops on a local Peritext + CommentManager.
    const peritext = new Peritext({ node: "alice" });
    const store = new CommentStore();
    const manager = new CommentManager(peritext, store, { node: "alice" });
    const textOps = peritext.insert(0, "Hello");
    const boldOp = peritext.addMark(0, 5, "bold", true);
    const created2 = manager.create(0, 5, "alice", "first");

    const envs: OpEnvelope[] = [
      ...textOps.map((p) => ({
        docId,
        layer: "peritext" as const,
        payload: p,
      })),
      { docId, layer: "peritext" as const, payload: boldOp },
      { docId, layer: "peritext" as const, payload: created2.markOp },
      { docId, layer: "comment" as const, payload: created2.commentOp },
    ];

    const submit = await app.fastify.inject({
      method: "POST",
      url: `/documents/${docId}/ops`,
      payload: { ops: envs },
    });
    expect(submit.statusCode).toBe(200);
    const result = submit.json() as { accepted: OpEnvelope[] };
    expect(result.accepted.length).toBe(envs.length);

    // Replay idempotency: posting again accepts nothing new.
    const replay = await app.fastify.inject({
      method: "POST",
      url: `/documents/${docId}/ops`,
      payload: { ops: envs },
    });
    const replayed = replay.json() as { accepted: OpEnvelope[] };
    expect(replayed.accepted.length).toBe(0);

    // Bootstrap as a brand-new client (empty vv).
    const state = await app.fastify.inject({
      method: "GET",
      url: `/documents/${docId}/state`,
    });
    expect(state.statusCode).toBe(200);
    const { ops } = state.json() as { ops: OpEnvelope[] };
    expect(ops.length).toBe(envs.length);
  });

  it("404s for unknown doc", async () => {
    const r = await app.fastify.inject({
      method: "GET",
      url: "/documents/00000000-0000-0000-0000-000000000000",
    });
    expect(r.statusCode).toBe(404);
  });

  it("rejects bad ops body", async () => {
    const created = await app.fastify.inject({
      method: "POST",
      url: "/documents",
    });
    const { id: docId } = created.json() as { id: string };
    const bad = await app.fastify.inject({
      method: "POST",
      url: `/documents/${docId}/ops`,
      payload: { ops: "nope" },
    });
    expect(bad.statusCode).toBe(400);
  });
});
