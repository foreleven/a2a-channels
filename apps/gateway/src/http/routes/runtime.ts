import { Hono } from "hono";
import { injectable, inject } from "inversify";
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

export const RuntimeStatusSourceToken = Symbol.for(
  "http.RuntimeStatusSource",
);

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
    if (typeof this.runtime.listConnections === "function") {
      return await this.runtime.listConnections();
    }

    if (typeof this.runtime.listConnectionStatuses === "function") {
      return await this.runtime.listConnectionStatuses();
    }

    return [];
  }
}
