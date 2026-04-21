import { Hono } from "hono";
import type { RuntimeConnectionStatus } from "@a2a-channels/core";

import type {
  RuntimeConnectionListItem,
  RuntimeNodeListItem,
} from "../../runtime/node-runtime-state-store.js";

type MaybePromise<T> = T | Promise<T>;

export interface RuntimeStatusSource {
  listNodes?(): MaybePromise<RuntimeNodeListItem[]>;
  listConnections?(): MaybePromise<RuntimeConnectionListItem[]>;
  listConnectionStatuses?(): MaybePromise<RuntimeConnectionStatus[]>;
}

export function registerRuntimeRoutes(
  app: Hono,
  runtime: RuntimeStatusSource,
): void {
  app.get("/api/runtime/nodes", async (c) => c.json(await listRuntimeNodes(runtime)));
  app.get("/api/runtime/connections", async (c) =>
    c.json(await listRuntimeConnections(runtime)),
  );
}

async function listRuntimeNodes(
  runtime: RuntimeStatusSource,
): Promise<RuntimeNodeListItem[]> {
  if (typeof runtime.listNodes !== "function") {
    return [];
  }

  return await runtime.listNodes();
}

async function listRuntimeConnections(
  runtime: RuntimeStatusSource,
): Promise<RuntimeConnectionListItem[] | RuntimeConnectionStatus[]> {
  if (typeof runtime.listConnections === "function") {
    return await runtime.listConnections();
  }

  if (typeof runtime.listConnectionStatuses === "function") {
    return await runtime.listConnectionStatuses();
  }

  return [];
}
