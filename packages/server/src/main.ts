import { Pool } from "pg";
import { buildApp } from "./app.js";
import { MemoryStorage } from "./storageMemory.js";
import { PostgresStorage } from "./storagePostgres.js";
import type { Storage } from "./storage.js";

// Entry point for `npm start`. Honors:
//   PORT                  default 8080
//   HOST                  default 0.0.0.0
//   DATABASE_URL          if set, use Postgres; else in-memory (dev only)
//   SNAPSHOT_EVERY_OPS    threshold for taking a snapshot (default 200)

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  const snapshotEvery = Number(process.env.SNAPSHOT_EVERY_OPS ?? 200);

  let storage: Storage;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    storage = new PostgresStorage(pool);
    console.log("storage: postgres");
  } else {
    storage = new MemoryStorage();
    console.log("storage: in-memory (NOT durable — dev use only)");
  }

  const { fastify } = await buildApp({
    storage,
    snapshotEvery,
    logger: true,
  });

  await fastify.listen({ port, host });
  console.log(`markcrdt-server listening on http://${host}:${port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
