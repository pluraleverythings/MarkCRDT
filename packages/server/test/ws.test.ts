import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Peritext } from "@markcrdt/core";
import {
  buildApp,
  MemoryStorage,
  type App,
  type ClientFrame,
  type OpEnvelope,
  type ServerFrame,
} from "../src/index.js";

let app: App;
let baseUrl: string;
let wsBase: string;

beforeAll(async () => {
  app = await buildApp({ storage: new MemoryStorage(), snapshotEvery: 1000 });
  await app.fastify.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.fastify.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsBase = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.fastify.close();
});

interface Client {
  socket: WebSocket;
  send(frame: ClientFrame): void;
  next(predicate: (f: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>;
  close(): void;
}

function connect(docId: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}/documents/${docId}/sync`);
    const queue: ServerFrame[] = [];
    const waiters: Array<{
      predicate: (f: ServerFrame) => boolean;
      resolve: (f: ServerFrame) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }> = [];

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as ServerFrame;
      // Try to satisfy a pending waiter.
      const idx = waiters.findIndex((w) => w.predicate(frame));
      if (idx >= 0) {
        const w = waiters.splice(idx, 1)[0]!;
        clearTimeout(w.timer);
        w.resolve(frame);
      } else {
        queue.push(frame);
      }
    });
    socket.on("open", () => {
      resolve({
        socket,
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: (predicate, timeoutMs = 2000) => {
          const idx = queue.findIndex(predicate);
          if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]!);
          return new Promise<ServerFrame>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("timeout waiting for frame")),
              timeoutMs,
            );
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          });
        },
        close: () => socket.close(),
      });
    });
    socket.on("error", reject);
  });
}

async function newDoc(): Promise<string> {
  const resp = await fetch(`${baseUrl}/documents`, { method: "POST" });
  const { id } = (await resp.json()) as { id: string };
  return id;
}

describe("WebSocket sync", () => {
  it("welcomes a fresh client with the existing op log", async () => {
    const docId = await newDoc();
    // Pre-load some ops via REST.
    const peritext = new Peritext({ node: "alice" });
    const textOps = peritext.insert(0, "hi");
    await fetch(`${baseUrl}/documents/${docId}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: textOps.map((p) => ({ docId, layer: "peritext", payload: p })),
      }),
    });

    const client = await connect(docId);
    client.send({ t: "hello", clientId: "bob", vv: {} });
    const welcome = await client.next((f) => f.t === "welcome");
    expect(welcome.t).toBe("welcome");
    if (welcome.t !== "welcome") throw new Error();
    expect(welcome.ops.length).toBe(2);
    expect(welcome.vv["alice"]).toBe(2);
    client.close();
  });

  it("fans out new ops to other connected clients", async () => {
    const docId = await newDoc();

    const alice = await connect(docId);
    alice.send({ t: "hello", clientId: "alice", vv: {} });
    await alice.next((f) => f.t === "welcome");

    const bob = await connect(docId);
    bob.send({ t: "hello", clientId: "bob", vv: {} });
    await bob.next((f) => f.t === "welcome");

    // Alice authors and pushes ops.
    const peritext = new Peritext({ node: "alice" });
    const ops = peritext.insert(0, "hello");
    const envs: OpEnvelope[] = ops.map((p) => ({
      docId,
      layer: "peritext",
      payload: p,
    }));
    alice.send({ t: "ops", ops: envs });
    await alice.next((f) => f.t === "ack");

    // Bob receives them on his stream.
    const bobOps = await bob.next((f) => f.t === "ops");
    if (bobOps.t !== "ops") throw new Error();
    expect(bobOps.ops.length).toBe(5);

    alice.close();
    bob.close();
  });

  it("does not echo a client's own ops back to itself", async () => {
    const docId = await newDoc();
    const alice = await connect(docId);
    alice.send({ t: "hello", clientId: "alice", vv: {} });
    await alice.next((f) => f.t === "welcome");

    const peritext = new Peritext({ node: "alice" });
    const ops = peritext.insert(0, "x");
    alice.send({
      t: "ops",
      ops: ops.map((p) => ({ docId, layer: "peritext", payload: p })),
    });
    await alice.next((f) => f.t === "ack");

    // Wait briefly and confirm we didn't get our own ops back as a frame.
    await new Promise((r) => setTimeout(r, 100));
    let echoed = false;
    try {
      await alice.next((f) => f.t === "ops", 50);
      echoed = true;
    } catch {
      // expected: timeout means no echo
    }
    expect(echoed).toBe(false);
    alice.close();
  });

  it("client with a partial vv only receives the missing tail", async () => {
    const docId = await newDoc();
    // Pre-load two ops.
    const peritext = new Peritext({ node: "alice" });
    const ops = peritext.insert(0, "ab");
    await fetch(`${baseUrl}/documents/${docId}/ops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops: ops.map((p) => ({ docId, layer: "peritext", payload: p })),
      }),
    });

    // Connect with vv claiming we already have alice@1.
    const client = await connect(docId);
    client.send({ t: "hello", clientId: "bob", vv: { alice: 1 } });
    const welcome = await client.next((f) => f.t === "welcome");
    if (welcome.t !== "welcome") throw new Error();
    expect(welcome.ops.length).toBe(1); // only the second op
    client.close();
  });
});
