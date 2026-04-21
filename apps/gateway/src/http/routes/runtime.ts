import { Hono } from "hono";

import type { RuntimeConnectionStatus } from "@a2a-channels/core";

export interface RuntimeStatusSource {
  listConnectionStatuses(): RuntimeConnectionStatus[];
}

export function registerRuntimeRoutes(
  app: Hono,
  runtime: RuntimeStatusSource,
): void {
  app.get("/api/runtime/connections", async (c) =>
    c.json(runtime.listConnectionStatuses()),
  );
}
