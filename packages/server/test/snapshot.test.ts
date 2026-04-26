import { describe, expect, it } from "vitest";
import { Peritext } from "@markcrdt/core";
import {
  buildApp,
  MemoryStorage,
  Snapshotter,
  type OpEnvelope,
} from "../src/index.js";

describe("Snapshotter", () => {
  it("takes a snapshot once the threshold is hit and serves it on bootstrap", async () => {
    const storage = new MemoryStorage();
    // Tiny threshold so we trigger after a couple of ops.
    const app = await buildApp({ storage, snapshotEvery: 3 });
    try {
      const created = await app.fastify.inject({
        method: "POST",
        url: "/documents",
      });
      const { id: docId } = created.json() as { id: string };

      const peritext = new Peritext({ node: "alice" });
      const insertOps = peritext.insert(0, "abc");
      const envs: OpEnvelope[] = insertOps.map((p) => ({
        docId,
        layer: "peritext" as const,
        payload: p,
      }));
      await app.fastify.inject({
        method: "POST",
        url: `/documents/${docId}/ops`,
        payload: { ops: envs },
      });

      // Threshold hit on the third op → a snapshot should exist.
      // The snapshot logic runs async after submitOps; await it via the
      // service.
      // (Forcing one is also fine and gives a deterministic test.)
      const snap = await storage.latestSnapshot(docId);
      expect(snap).not.toBeNull();
      expect(snap!.versionVector["alice"]).toBe(3);
      const state = snap!.state as { text: string };
      expect(state.text).toBe("abc");

      // A new client with empty vv gets a state response that includes
      // the snapshot AND skips the ops it covers.
      const stateResp = await app.fastify.inject({
        method: "GET",
        url: `/documents/${docId}/state`,
      });
      const body = stateResp.json() as {
        snapshot?: { versionVector: Record<string, number> };
        ops: OpEnvelope[];
      };
      expect(body.snapshot).toBeDefined();
      expect(body.snapshot!.versionVector["alice"]).toBe(3);
      // No further ops beyond the snapshot.
      expect(body.ops.length).toBe(0);
    } finally {
      await app.fastify.close();
    }
  });

  it("force-takes a snapshot on demand", async () => {
    const storage = new MemoryStorage();
    const app = await buildApp({ storage, snapshotEvery: 1_000_000 });
    try {
      const created = await app.fastify.inject({
        method: "POST",
        url: "/documents",
      });
      const { id: docId } = created.json() as { id: string };
      const peritext = new Peritext({ node: "alice" });
      const ops = peritext.insert(0, "x");
      await storage.appendOps(
        docId,
        ops.map((p) => ({ docId, layer: "peritext", payload: p })),
      );

      const snapper = new Snapshotter(storage, 1_000_000);
      await snapper.takeSnapshot(docId);
      const snap = await storage.latestSnapshot(docId);
      expect(snap).not.toBeNull();
      expect((snap!.state as { text: string }).text).toBe("x");
    } finally {
      await app.fastify.close();
    }
  });
});
