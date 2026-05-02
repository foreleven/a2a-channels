import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { GatewayConfigService } from "./config.js";
import {
  GatewayServer,
  type GatewayServerStartOptions,
} from "./gateway-server.js";
import type { ServiceContribution } from "./service-contribution.js";
import type { GatewayApp } from "../http/app.js";

function createApp(): GatewayApp {
  return {
    fetch: () => new Response("ok"),
  };
}

describe("GatewayServer", () => {
  test("starts service contributions and runtime before opening the HTTP listener", async () => {
    const events: string[] = [];
    const services: ServiceContribution[] = [
      {
        start: async () => {
          events.push("service:redis:start");
        },
        stop: async () => {
          events.push("service:redis:stop");
        },
      },
      {
        start: async () => {
          events.push("service:events:start");
        },
        stop: async () => {
          events.push("service:events:stop");
        },
      },
    ];
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
      services,
    );

    await server.start({ logger: { info: () => {}, error: () => {} } });
    await server.shutdown();

    assert.deepEqual(events, [
      "service:redis:start",
      "service:events:start",
      "runtime:bootstrap:start",
      "runtime:bootstrap:done",
      "http:listen",
      "http:close",
      "runtime:shutdown",
      "service:events:stop",
      "service:redis:stop",
    ]);
  });

  test("stops started service contributions when a later service fails", async () => {
    const events: string[] = [];
    const failure = new Error("events failed");
    const services: ServiceContribution[] = [
      {
        start: async () => {
          events.push("service:redis:start");
        },
        stop: async () => {
          events.push("service:redis:stop");
        },
      },
      {
        start: async () => {
          events.push("service:events:start");
          throw failure;
        },
        stop: async () => {
          events.push("service:events:stop");
        },
      },
    ];
    const runtime = {
      bootstrap: async () => {
        events.push("runtime:bootstrap");
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
      services,
    );

    await assert.rejects(
      server.start({ logger: { info: () => {}, error: () => {} } }),
      failure,
    );

    assert.deepEqual(events, [
      "service:redis:start",
      "service:events:start",
      "service:redis:stop",
    ]);
  });
});
