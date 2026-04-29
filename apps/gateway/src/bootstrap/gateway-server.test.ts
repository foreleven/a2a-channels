import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { GatewayConfigService } from "./config.js";
import {
  GatewayServer,
  type GatewayServerStartOptions,
} from "./gateway-server.js";
import type { GatewayApp } from "../http/app.js";

function createApp(): GatewayApp {
  return {
    fetch: () => new Response("ok"),
  };
}

describe("GatewayServer", () => {
  test("starts runtime lifecycle before opening the HTTP listener", async () => {
    const events: string[] = [];
    const runtime = {
      bootstrap: async () => {
        events.push("runtime:bootstrap:start");
        await Promise.resolve();
        events.push("runtime:bootstrap:done");
      },
      shutdown: async () => {
        events.push("runtime:shutdown");
      },
    };
    const serve = (() => {
      events.push("http:listen");
      return { close: () => events.push("http:close") };
    }) as unknown as NonNullable<GatewayServerStartOptions["serve"]>;
    const server = new GatewayServer(
      new GatewayConfigService({ port: 9991 }),
      createApp(),
      runtime,
      serve,
    );

    await server.start({ logger: { info: () => {}, error: () => {} } });
    await server.shutdown();

    assert.deepEqual(events, [
      "runtime:bootstrap:start",
      "runtime:bootstrap:done",
      "http:listen",
      "http:close",
      "runtime:shutdown",
    ]);
  });
});
