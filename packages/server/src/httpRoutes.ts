import type { FastifyInstance } from "fastify";
import { DocNotFound, type DocService } from "./docService.js";
import type { OpEnvelope, VersionVector } from "./types.js";

interface SubmitBody {
  ops: OpEnvelope[];
}

interface StateQuery {
  vv?: string; // base64-encoded JSON of the client's version vector
}

export async function registerHttpRoutes(
  app: FastifyInstance,
  service: DocService,
): Promise<void> {
  // POST /documents — create a new document.
  app.post("/documents", async () => {
    const meta = await service.createDoc();
    return meta;
  });

  // GET /documents — list (most recent first).
  app.get<{ Querystring: { limit?: string } }>("/documents", async (req) => {
    const limit = req.query.limit ? Math.min(500, Number(req.query.limit)) : 100;
    return service.listDocs(limit);
  });

  // GET /documents/:id — metadata.
  app.get<{ Params: { id: string } }>("/documents/:id", async (req, reply) => {
    const meta = await service.getDoc(req.params.id);
    if (!meta) return reply.code(404).send({ error: "not_found" });
    return meta;
  });

  // GET /documents/:id/state — bootstrap payload (snapshot + ops since).
  // Pass `?vv=<base64-json>` to skip ops you already have.
  app.get<{ Params: { id: string }; Querystring: StateQuery }>(
    "/documents/:id/state",
    async (req, reply) => {
      const clientVv = parseVv(req.query.vv);
      try {
        const state = await service.stateForClient(req.params.id, clientVv);
        return state;
      } catch (err) {
        if (err instanceof DocNotFound) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw err;
      }
    },
  );

  // POST /documents/:id/ops — REST fallback for clients without WS.
  app.post<{ Params: { id: string }; Body: SubmitBody }>(
    "/documents/:id/ops",
    async (req, reply) => {
      if (!req.body || !Array.isArray(req.body.ops)) {
        return reply.code(400).send({ error: "ops_array_required" });
      }
      try {
        const result = await service.submitOps(req.params.id, req.body.ops);
        return result;
      } catch (err) {
        if (err instanceof DocNotFound) {
          return reply.code(404).send({ error: "not_found" });
        }
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
}

function parseVv(s: string | undefined): VersionVector {
  if (!s) return {};
  try {
    const json = Buffer.from(s, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as VersionVector;
  } catch {
    return {};
  }
}
