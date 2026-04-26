import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { DocNotFound, type DocService } from "./docService.js";
import { envelopesNotIn } from "./opKey.js";
import type {
  ClientFrame,
  OpEnvelope,
  ServerFrame,
  VersionVector,
} from "./types.js";

interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (msg: Buffer | string) => void): void;
  on(event: "close", cb: () => void): void;
  on(event: "error", cb: (err: Error) => void): void;
}

export async function registerWsRoutes(
  app: FastifyInstance,
  service: DocService,
): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/documents/:id/sync",
    { websocket: true },
    (socket: unknown, req) => {
      const docId = req.params.id;
      const ws = socket as SocketLike;
      handleSocket(ws, docId, service).catch((err) => {
        sendSafe(ws, {
          t: "error",
          code: "internal",
          message: (err as Error).message,
        });
        ws.close();
      });
    },
  );
}

async function handleSocket(
  ws: SocketLike,
  docId: string,
  service: DocService,
): Promise<void> {
  const meta = await service.getDoc(docId);
  if (!meta) {
    sendSafe(ws, { t: "error", code: "not_found", message: "doc not found" });
    ws.close();
    return;
  }

  // Per-connection state.
  let clientId: string | null = null;
  let clientVv: VersionVector = {};
  let helloDone = false;
  let unsub: (() => void) | null = null;

  // The client may push ops (via "ops" frames) that we should fan out to
  // others (NOT echo back). Track our own outbound queue ids so we can
  // dedupe — actually, simplest is: each connection's listener compares
  // against its own clientVv. If we just appended our own op, our clientVv
  // is bumped before the listener fires.

  const onIncomingFromOthers = (ops: OpEnvelope[]): void => {
    if (!helloDone) return;
    const send = envelopesNotIn(ops, clientVv);
    if (send.length === 0) return;
    for (const e of send) {
      const k = e.payload as { opId: { counter: number; node: string } };
      clientVv = { ...clientVv, [k.opId.node]: Math.max(clientVv[k.opId.node] ?? 0, k.opId.counter) };
    }
    sendSafe(ws, { t: "ops", ops: send });
  };

  ws.on("message", async (raw: Buffer | string) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as ClientFrame;
    } catch {
      sendSafe(ws, { t: "error", code: "bad_json", message: "invalid json" });
      return;
    }
    try {
      switch (frame.t) {
        case "hello": {
          if (helloDone) return;
          clientId = frame.clientId || randomUUID();
          clientVv = frame.vv ?? {};
          const state = await service.stateForClient(docId, clientVv);
          // Bump our local view of vv so we don't re-send these ops.
          for (const e of state.ops) {
            const k = e.payload as { opId: { counter: number; node: string } };
            clientVv = { ...clientVv, [k.opId.node]: Math.max(clientVv[k.opId.node] ?? 0, k.opId.counter) };
          }
          if (state.snapshot) {
            // Snapshot covers up to its versionVector.
            for (const [n, c] of Object.entries(state.snapshot.versionVector)) {
              clientVv = { ...clientVv, [n]: Math.max(clientVv[n] ?? 0, c) };
            }
          }
          sendSafe(ws, {
            t: "welcome",
            clientId,
            vv: state.vv,
            snapshot: state.snapshot,
            ops: state.ops,
          });
          helloDone = true;
          unsub = service.subscribe(docId, onIncomingFromOthers);
          return;
        }
        case "ops": {
          if (!helloDone) {
            sendSafe(ws, {
              t: "error",
              code: "no_hello",
              message: "send hello first",
            });
            return;
          }
          // Stamp the doc id from the URL — clients shouldn't be able to
          // submit ops to other docs over this socket.
          const stamped = frame.ops.map((e) => ({ ...e, docId }));
          // Bump clientVv before submit so the fanout listener won't echo.
          for (const e of stamped) {
            const k = e.payload as { opId: { counter: number; node: string } };
            clientVv = { ...clientVv, [k.opId.node]: Math.max(clientVv[k.opId.node] ?? 0, k.opId.counter) };
          }
          const { vv } = await service.submitOps(docId, stamped);
          sendSafe(ws, { t: "ack", vv });
          return;
        }
        case "ping":
          sendSafe(ws, { t: "pong" });
          return;
      }
    } catch (err) {
      if (err instanceof DocNotFound) {
        sendSafe(ws, { t: "error", code: "not_found", message: err.message });
      } else {
        sendSafe(ws, {
          t: "error",
          code: "bad_request",
          message: (err as Error).message,
        });
      }
    }
  });

  ws.on("close", () => {
    if (unsub) unsub();
  });
  ws.on("error", () => {
    if (unsub) unsub();
  });
}

function sendSafe(ws: SocketLike, frame: ServerFrame): void {
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // socket may already be closed
  }
}
