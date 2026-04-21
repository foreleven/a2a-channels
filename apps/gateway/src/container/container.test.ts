import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { Container } from "inversify";

import { SYSTEM_TOKENS } from "@a2a-channels/di";

import { buildGatewayConfig } from "../bootstrap/config.js";
import type { GatewayConfig } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";

describe("buildGatewayContainer", () => {
  test("resolves typed config", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);
    const resolved = container.get<GatewayConfig>(SYSTEM_TOKENS.GatewayConfig);

    assert.equal(resolved.port, 7891);
  });
});
