import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentCallContext,
  AgentRequest,
  AgentResponse,
  AgentTransport,
} from "@agent-relay/agent-transport";
import { ACPRemoteExecutor } from "./relay-executor.js";
import type { RunnerConfig } from "../types.js";

test("ACPRemoteExecutor reuses returned protocol session ids", async () => {
  const contexts: AgentCallContext[] = [];
  const transport: AgentTransport = {
    protocol: "acp",
    async send(
      _request: AgentRequest,
      ctx: AgentCallContext,
    ): Promise<AgentResponse> {
      contexts.push(ctx);
      return {
        text: "ok",
        protocolSessionId: "acp-session-1",
      };
    },
  };
  const runnerConfig: RunnerConfig = {
    agentId: "remote-agent",
    name: "remote-agent",
    gatewayWsUrl: "ws://localhost:7890/ws/a2a/remote-agent",
    executor: {
      type: "codex",
      command: "npx",
      args: ["@zed-industries/codex-acp"],
    },
  };

  const executor = new ACPRemoteExecutor(
    runnerConfig,
    runnerConfig.executor,
    transport,
  );

  await executor.execute("first");
  await executor.execute("second");

  assert.deepEqual(contexts, [
    { protocolSessionId: undefined },
    { protocolSessionId: "acp-session-1" },
  ]);
});
