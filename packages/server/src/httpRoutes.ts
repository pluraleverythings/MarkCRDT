import type { FastifyInstance } from "fastify";
import { DocNotFound, type DocService } from "./docService.js";
import { HandleTaken } from "./storageMemory.js";
import type { OpEnvelope, Role, VersionVector } from "./types.js";

interface SubmitBody {
  ops: OpEnvelope[];
}

interface StateQuery {
  vv?: string; // base64-encoded JSON of the client's version vector
}

const ROLES: Role[] = ["owner", "editor", "viewer"];

export async function registerHttpRoutes(
  app: FastifyInstance,
  service: DocService,
): Promise<void> {
  // POST /documents — create a new document.
  // Optional body: { ownerId } — if given, the user is added as owner.
  app.post<{ Body?: { ownerId?: string } }>("/documents", async (req, reply) => {
    const ownerId = req.body?.ownerId;
    if (ownerId) {
      const u = await service.db.getUser(ownerId);
      if (!u) return reply.code(404).send({ error: "owner_not_found" });
    }
    const meta = await service.createDoc({ ownerId });
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

  // ---------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------

  app.post<{ Body?: { handle?: string; displayName?: string } }>(
    "/users",
    async (req, reply) => {
      const handle = req.body?.handle?.trim();
      if (!handle) return reply.code(400).send({ error: "handle_required" });
      try {
        const u = await service.db.createUser({
          handle,
          displayName: req.body?.displayName ?? null,
        });
        return u;
      } catch (err) {
        if (err instanceof HandleTaken) {
          return reply.code(409).send({ error: "handle_taken" });
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { limit?: string; handle?: string } }>(
    "/users",
    async (req) => {
      if (req.query.handle) {
        const u = await service.db.getUserByHandle(req.query.handle);
        return u ? [u] : [];
      }
      const limit = req.query.limit
        ? Math.min(500, Number(req.query.limit))
        : 100;
      return service.db.listUsers(limit);
    },
  );

  app.get<{ Params: { id: string } }>("/users/:id", async (req, reply) => {
    const u = await service.db.getUser(req.params.id);
    if (!u) return reply.code(404).send({ error: "not_found" });
    return u;
  });

  app.delete<{ Params: { id: string } }>(
    "/users/:id",
    async (req, reply) => {
      await service.db.deleteUser(req.params.id);
      return reply.code(204).send();
    },
  );

  // GET /users/:id/documents — every doc the user is a member of.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/users/:id/documents",
    async (req, reply) => {
      const u = await service.db.getUser(req.params.id);
      if (!u) return reply.code(404).send({ error: "not_found" });
      const limit = req.query.limit
        ? Math.min(500, Number(req.query.limit))
        : 100;
      return service.db.listDocsForUser(req.params.id, limit);
    },
  );

  // POST /users/:id/documents — create a doc with this user as owner.
  app.post<{ Params: { id: string } }>(
    "/users/:id/documents",
    async (req, reply) => {
      const u = await service.db.getUser(req.params.id);
      if (!u) return reply.code(404).send({ error: "not_found" });
      return service.createDoc({ ownerId: req.params.id });
    },
  );

  // ---------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/documents/:id/members",
    async (req, reply) => {
      const meta = await service.getDoc(req.params.id);
      if (!meta) return reply.code(404).send({ error: "not_found" });
      return service.db.listMembers(req.params.id);
    },
  );

  app.put<{
    Params: { id: string; userId: string };
    Body?: { role?: string };
  }>("/documents/:id/members/:userId", async (req, reply) => {
    const role = (req.body?.role ?? "editor") as Role;
    if (!ROLES.includes(role)) {
      return reply.code(400).send({ error: "bad_role" });
    }
    const meta = await service.getDoc(req.params.id);
    if (!meta) return reply.code(404).send({ error: "doc_not_found" });
    const u = await service.db.getUser(req.params.userId);
    if (!u) return reply.code(404).send({ error: "user_not_found" });
    return service.db.addMember(req.params.id, req.params.userId, role);
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    "/documents/:id/members/:userId",
    async (req, reply) => {
      await service.db.removeMember(req.params.id, req.params.userId);
      return reply.code(204).send();
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
