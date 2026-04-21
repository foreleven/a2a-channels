import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Container } from "inversify";

import { registerAgentRoutes } from "./routes/agents.js";
import { registerChannelRoutes } from "./routes/channels.js";
import {
  registerRuntimeRoutes,
  type RuntimeStatusSource,
} from "./routes/runtime.js";

export interface BuildHttpAppOptions {
  corsOrigin: string | string[];
  runtime: RuntimeStatusSource;
  webDir: string;
}

export function buildHttpApp(
  container: Container,
  options: BuildHttpAppOptions,
): Hono {
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: options.corsOrigin,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/", async (c) => {
    try {
      const html = await readFile(join(options.webDir, "index.html"), "utf-8");
      return c.html(html);
    } catch {
      return c.html("<h1>Web UI not found</h1>", 404);
    }
  });

  registerChannelRoutes(app, container);
  registerAgentRoutes(app, container);
  registerRuntimeRoutes(app, options.runtime);

  return app;
}
