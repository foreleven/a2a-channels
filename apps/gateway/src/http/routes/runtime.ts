import { Hono } from "hono";
import { injectable, inject } from "inversify";

import type {
  RuntimeConnectionListItem,
  RuntimeNodeListItem,
} from "../../runtime/node-runtime-state-store.js";
import type { RuntimeConnectionStatus } from "../../runtime/runtime-connection-status.js";

type MaybePromise<T> = T | Promise<T>;

/**
 * Small read-model boundary for runtime status endpoints.
 *
 * The runtime UI has evolved across two shapes:
 * - newer readers expose listNodes/listConnections
 * - older relay-oriented code exposed listConnectionStatuses only
 *
 * This token keeps the HTTP transport compatible with both.
 */
export interface RuntimeStatusSource {
  listNodes?(): MaybePromise<RuntimeNodeListItem[]>;
  listConnections?(): MaybePromise<RuntimeConnectionListItem[]>;
  listConnectionStatuses?(): MaybePromise<RuntimeConnectionStatus[]>;
}

export const RuntimeStatusSourceToken = Symbol.for(
  "http.RuntimeStatusSource",
);

/**
 * Read-only runtime endpoints used by the admin UI.
 *
 * Unlike the channel/agent routes, these endpoints sit on top of a derived
 * read model rather than command-oriented application services.
 */
@injectable()
export class RuntimeRoutes {
  constructor(
    @inject(RuntimeStatusSourceToken)
    private readonly runtime: RuntimeStatusSource,
  ) {}

  register(app: Hono): void {
    app.get("/api/runtime/nodes", async (c) =>
      c.json(await this.listRuntimeNodes()),
    );
    app.get("/api/runtime/connections", async (c) =>
      c.json(await this.listRuntimeConnections()),
    );
  }

  private async listRuntimeNodes(): Promise<RuntimeNodeListItem[]> {
    if (typeof this.runtime.listNodes !== "function") {
      return [];
    }

    return await this.runtime.listNodes();
  }

  private async listRuntimeConnections(): Promise<
    RuntimeConnectionListItem[] | RuntimeConnectionStatus[]
  > {
    // Prefer the richer read model when available, but keep compatibility with
    // the narrower status-only API used by older tests and adapters.
    if (typeof this.runtime.listConnections === "function") {
      return await this.runtime.listConnections();
    }

    if (typeof this.runtime.listConnectionStatuses === "function") {
      return await this.runtime.listConnectionStatuses();
    }

    return [];
  }
}
