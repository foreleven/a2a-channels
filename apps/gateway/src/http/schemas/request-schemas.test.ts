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

  // ---------------------------------------------------------------------------
  // ws-tunnel configs
  // ---------------------------------------------------------------------------

  test("accepts a minimal ws-tunnel agent config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "my-relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: { type: "claude-code", command: "claude" },
      },
    });

    assert.equal(parsed.success, true, JSON.stringify(parsed));
  });

  test("accepts a full ws-tunnel agent config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "full-relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: {
          type: "claude-code",
          command: "claude",
          args: ["--experimental-acp"],
          cwd: "/tmp/agent",
          permission: "reject_once",
          timeoutMs: 30_000,
        },
        timeoutMs: 30_000,
      },
    });

    assert.equal(parsed.success, true, JSON.stringify(parsed));
  });

  test("rejects ws-tunnel config without an executor", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "bad-relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
      },
    });

    assert.equal(parsed.success, false);
  });

  test("rejects ws-tunnel config with wrong executor type", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "bad-exec-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: { type: "openai" },
      },
    });

    assert.equal(parsed.success, false);
  });

  test("accepts a codex ACP Remote executor config", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "codex-relay-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: {
          type: "codex",
          command: "npx",
          args: ["@zed-industries/codex-acp"],
        },
      },
    });

    assert.equal(parsed.success, true, JSON.stringify(parsed));
  });

  test("rejects ws-tunnel protocol paired with a non-ws-tunnel transport", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "mismatch-agent",
      protocol: "ws-tunnel",
      config: {
        transport: "stdio",
        command: "npx",
      },
    });

    assert.equal(parsed.success, false);
  });

  test("rejects relayToken supplied in the request body", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "relay-with-token",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: { type: "claude-code", command: "claude" },
        relayToken: "user-supplied-token",  // must be rejected by strict()
      },
    });

    assert.equal(parsed.success, false);
  });

  test("defaults relayToken to empty string when not supplied", () => {
    const parsed = registerAgentBodySchema.safeParse({
      name: "relay-no-token",
      protocol: "ws-tunnel",
      config: {
        transport: "ws-tunnel",
        executor: { type: "claude-code", command: "claude" },
      },
    });

    assert.equal(parsed.success, true);
    if (parsed.success) {
      const cfg = parsed.data.config as { relayToken?: string };
      assert.equal(cfg.relayToken, "");
    }
  });
});
