import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  registerAgentBodySchema,
  updateAgentBodySchema,
} from "./request-schemas.js";

describe("agent request schemas", () => {
  test("rejects ACP REST transport config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "ACP REST",
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
});
