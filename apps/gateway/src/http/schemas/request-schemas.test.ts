import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  registerAgentBodySchema,
  updateAgentBodySchema,
} from "./request-schemas.js";

describe("agent request schemas", () => {
  test("preserves ACP REST transport while parsing agent config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "ACP REST",
      protocol: "acp",
      config: { transport: "rest", url: "http://localhost:8000" },
    });

    assert.equal(parsed.success, true);
    if (!parsed.success) return;
    assert.deepEqual(parsed.data.config, {
      transport: "rest",
      url: "http://localhost:8000",
    });
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
