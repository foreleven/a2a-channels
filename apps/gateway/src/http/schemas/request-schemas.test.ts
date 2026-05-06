import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  registerAgentBodySchema,
  updateAgentBodySchema,
} from "./request-schemas.js";

describe("agent request schemas", () => {
  test("rejects ACP REST transport config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "acp-rest",
      protocol: "acp",
      config: { transport: "rest", url: "http://localhost:8000" },
    });

    assert.equal(parsed.success, false);
  });

  test("rejects A2A config carrying ACP transport fields", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "Invalid",
      protocol: "a2a",
      config: { transport: "rest", url: "http://localhost:8000" },
    });

    assert.equal(parsed.success, false);
  });

  test("accepts partial update bodies", () => {
    const parsed = updateAgentBodySchema.safeParse({ protocol: "acp" });

    assert.equal(parsed.success, true);
  });

  test("rejects agent names that cannot be used as folder names", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "Invalid Agent",
      protocol: "acp",
      config: { transport: "stdio", command: "npx" },
    });

    assert.equal(parsed.success, false);
  });

  test("rejects ACP stdio configs carrying a nested name", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "acp-agent",
      protocol: "acp",
      config: { transport: "stdio", command: "npx", name: "nested-name" },
    });

    assert.equal(parsed.success, false);
  });
});
