import { Hono } from "hono";
import { inject, injectable } from "inversify";

import { RuntimeStatusService } from "../../application/runtime-status-service.js";

/** HTTP adapter for admin runtime status read models. */
@injectable()
export class RuntimeStatusRoutes {
  constructor(
    @inject(RuntimeStatusService)
    private readonly runtimeStatus: RuntimeStatusService,
  ) {}

  register(app: Hono): void {
    app.get("/api/runtime/status", async (c) =>
      c.json(await this.runtimeStatus.getStatus()),
    );

    app.get("/api/runtime/nodes", async (c) => {
      const status = await this.runtimeStatus.getStatus();
      return c.json(status.nodes);
    });

    app.get("/api/runtime/connections", async (c) => {
      const status = await this.runtimeStatus.getStatus();
      return c.json(status.channels);
    });
  }
}
