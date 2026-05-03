import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";
import { AgentRoutes } from "./routes/agents.js";
import { ChannelRoutes } from "./routes/channels.js";
import { RuntimeStatusRoutes } from "./routes/runtime-status.js";

export interface GatewayApp {
  fetch(request: Request, env: unknown): Promise<unknown> | unknown;
  request?: Hono["request"];
}

export const GatewayApp = Symbol.for("http.GatewayApp");
export const GatewayWebDir = Symbol.for("http.GatewayWebDir");

/**
 * Thin HTTP composition layer.
 *
 * This class owns transport concerns only: CORS policy, static root handling,
 * and route registration. Business logic lives in the injected route classes
 * and deeper application/runtime services.
 */
@injectable()
export class HonoGatewayApp implements GatewayApp {
  readonly request: Hono["request"];
  private readonly app: Hono;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayWebDir)
    private readonly webDir: string,
    @inject(ChannelRoutes)
    private readonly channelRoutes: ChannelRoutes,
    @inject(AgentRoutes)
    private readonly agentRoutes: AgentRoutes,
    @inject(RuntimeStatusRoutes)
    private readonly runtimeStatusRoutes: RuntimeStatusRoutes,
  ) {
    this.app = this.createApp();
    this.request = this.app.request.bind(this.app);
  }

  fetch(request: Request, env: unknown): Promise<unknown> | unknown {
    return this.app.fetch(request, env);
  }

  private createApp(): Hono {
    const app = new Hono();

    // The browser-based admin UI calls the JSON API directly, so CORS is only
    // needed on the API subtree.
    app.use(
      "/api/*",
      cors({
        origin: this.config.corsOrigin,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type"],
      }),
    );

    app.get("/", async (c) => {
      try {
        // The gateway can still serve a legacy/static web UI build at "/".
        const html = await readFile(`${this.webDir}/index.html`, "utf-8");
        return c.html(html);
      } catch {
        return c.html("<h1>Web UI not found</h1>", 404);
      }
    });

    this.channelRoutes.register(app);
    this.agentRoutes.register(app);
    this.runtimeStatusRoutes.register(app);

    return app;
  }
}
