import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, MemoryStorage, type App } from "../src/index.js";

let app: App;

beforeAll(async () => {
  app = await buildApp({ storage: new MemoryStorage(), snapshotEvery: 1000 });
});

afterAll(async () => {
  await app.fastify.close();
});

async function createUser(handle: string, displayName?: string) {
  const r = await app.fastify.inject({
    method: "POST",
    url: "/users",
    payload: { handle, displayName },
  });
  if (r.statusCode !== 200) {
    throw new Error(`createUser ${handle}: ${r.statusCode} ${r.body}`);
  }
  return r.json() as { id: string; handle: string };
}

describe("Users — CRUD", () => {
  it("creates, fetches by id, and looks up by handle", async () => {
    const u = await createUser("alice@example.com", "Alice");
    expect(u.handle).toBe("alice@example.com");

    const byId = await app.fastify.inject({
      method: "GET",
      url: `/users/${u.id}`,
    });
    expect(byId.statusCode).toBe(200);
    expect(byId.json()).toMatchObject({ id: u.id, handle: u.handle });

    const byHandle = await app.fastify.inject({
      method: "GET",
      url: `/users?handle=${encodeURIComponent(u.handle)}`,
    });
    const list = byHandle.json() as { id: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(u.id);
  });

  it("rejects duplicate handles with 409", async () => {
    await createUser("dup@example.com");
    const r = await app.fastify.inject({
      method: "POST",
      url: "/users",
      payload: { handle: "dup@example.com" },
    });
    expect(r.statusCode).toBe(409);
  });

  it("400 on missing handle", async () => {
    const r = await app.fastify.inject({
      method: "POST",
      url: "/users",
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it("delete removes the user and 404s on subsequent fetch", async () => {
    const u = await createUser("ghost@example.com");
    const del = await app.fastify.inject({
      method: "DELETE",
      url: `/users/${u.id}`,
    });
    expect(del.statusCode).toBe(204);
    const r = await app.fastify.inject({
      method: "GET",
      url: `/users/${u.id}`,
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("Documents — by user", () => {
  it("creating a doc with ownerId records membership", async () => {
    const u = await createUser("owner@example.com");
    const create = await app.fastify.inject({
      method: "POST",
      url: "/documents",
      payload: { ownerId: u.id },
    });
    expect(create.statusCode).toBe(200);
    const doc = create.json() as { id: string };

    const members = await app.fastify.inject({
      method: "GET",
      url: `/documents/${doc.id}/members`,
    });
    expect(members.statusCode).toBe(200);
    const list = members.json() as { userId: string; role: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ userId: u.id, role: "owner" });
  });

  it("POST /users/:id/documents creates with the user as owner", async () => {
    const u = await createUser("creator@example.com");
    const r = await app.fastify.inject({
      method: "POST",
      url: `/users/${u.id}/documents`,
    });
    expect(r.statusCode).toBe(200);
    const doc = r.json() as { id: string };
    const members = await app.fastify.inject({
      method: "GET",
      url: `/documents/${doc.id}/members`,
    });
    const list = members.json() as { userId: string; role: string }[];
    expect(list[0]).toMatchObject({ userId: u.id, role: "owner" });
  });

  it("GET /users/:id/documents lists every doc the user is a member of", async () => {
    const u = await createUser("multi@example.com");
    const a = await app.fastify.inject({
      method: "POST",
      url: `/users/${u.id}/documents`,
    });
    const b = await app.fastify.inject({
      method: "POST",
      url: `/users/${u.id}/documents`,
    });
    const docA = (a.json() as { id: string }).id;
    const docB = (b.json() as { id: string }).id;

    // Plus a doc owned by someone else where this user is added as editor.
    const other = await createUser("other@example.com");
    const c = await app.fastify.inject({
      method: "POST",
      url: `/users/${other.id}/documents`,
    });
    const docC = (c.json() as { id: string }).id;
    await app.fastify.inject({
      method: "PUT",
      url: `/documents/${docC}/members/${u.id}`,
      payload: { role: "editor" },
    });

    const list = await app.fastify.inject({
      method: "GET",
      url: `/users/${u.id}/documents`,
    });
    expect(list.statusCode).toBe(200);
    const docs = list.json() as { id: string }[];
    const ids = new Set(docs.map((d) => d.id));
    expect(ids.has(docA)).toBe(true);
    expect(ids.has(docB)).toBe(true);
    expect(ids.has(docC)).toBe(true);
  });

  it("404s when ownerId on /documents is unknown", async () => {
    const r = await app.fastify.inject({
      method: "POST",
      url: "/documents",
      payload: { ownerId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(r.statusCode).toBe(404);
  });
});

describe("Membership — add / remove / list", () => {
  it("PUT adds an editor; removing them updates list", async () => {
    const owner = await createUser("o@example.com");
    const editor = await createUser("e@example.com");
    const create = await app.fastify.inject({
      method: "POST",
      url: `/users/${owner.id}/documents`,
    });
    const docId = (create.json() as { id: string }).id;

    const add = await app.fastify.inject({
      method: "PUT",
      url: `/documents/${docId}/members/${editor.id}`,
      payload: { role: "editor" },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({ userId: editor.id, role: "editor" });

    const list1 = await app.fastify.inject({
      method: "GET",
      url: `/documents/${docId}/members`,
    });
    expect(list1.json()).toHaveLength(2);

    const del = await app.fastify.inject({
      method: "DELETE",
      url: `/documents/${docId}/members/${editor.id}`,
    });
    expect(del.statusCode).toBe(204);
    const list2 = await app.fastify.inject({
      method: "GET",
      url: `/documents/${docId}/members`,
    });
    expect(list2.json()).toHaveLength(1);
  });

  it("PUT with bad role returns 400", async () => {
    const owner = await createUser("z@example.com");
    const create = await app.fastify.inject({
      method: "POST",
      url: `/users/${owner.id}/documents`,
    });
    const docId = (create.json() as { id: string }).id;
    const r = await app.fastify.inject({
      method: "PUT",
      url: `/documents/${docId}/members/${owner.id}`,
      payload: { role: "admin" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("deleting a user cascades to memberships", async () => {
    const owner = await createUser("oo@example.com");
    const editor = await createUser("ee@example.com");
    const create = await app.fastify.inject({
      method: "POST",
      url: `/users/${owner.id}/documents`,
    });
    const docId = (create.json() as { id: string }).id;
    await app.fastify.inject({
      method: "PUT",
      url: `/documents/${docId}/members/${editor.id}`,
      payload: { role: "editor" },
    });

    await app.fastify.inject({
      method: "DELETE",
      url: `/users/${editor.id}`,
    });

    const list = await app.fastify.inject({
      method: "GET",
      url: `/documents/${docId}/members`,
    });
    const ids = (list.json() as { userId: string }[]).map((m) => m.userId);
    expect(ids).not.toContain(editor.id);
    expect(ids).toContain(owner.id);
  });
});
