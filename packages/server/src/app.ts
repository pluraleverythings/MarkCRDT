import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { DocService } from "./docService.js";
import { registerHttpRoutes } from "./httpRoutes.js";
import { registerWsRoutes } from "./wsRoutes.js";
import type { Storage } from "./storage.js";
import { Snapshotter } from "./snapshot.js";

export interface AppOptions {
  storage: Storage;
  /** When op count grows by this many since the last snapshot, take one. */
  snapshotEvery?: number;
  logger?: boolean;
}

export interface App {
  fastify: FastifyInstance;
  service: DocService;
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const fastify = Fastify({ logger: opts.logger ?? false });
  await fastify.register(websocket);

  const snapshotter = new Snapshotter(opts.storage, opts.snapshotEvery ?? 200);
  const service = new DocService(opts.storage, snapshotter);

  await registerHttpRoutes(fastify, service);
  await registerWsRoutes(fastify, service);

  return { fastify, service };
}
