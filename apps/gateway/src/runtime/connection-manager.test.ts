import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AgentClient, type AgentTransport } from "@a2a-channels/agent-transport";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import { OpenClawPluginRuntime } from "@a2a-channels/openclaw-compat";
import type { MessageOutboundEvent } from "@a2a-channels/openclaw-compat";

import { Connection, ConnectionManager } from "./connection-manager.js";

const binding: ChannelBindingSnapshot = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: { appId: "cli_1", appSecret: "sec_1" },
  agentId: "agent-1",
  enabled: true,
  createdAt: new Date().toISOString(),
};

describe("Connection", () => {
  test("listens for its own inbound runtime messages", async () => {
    const sentMessages: string[] = [];
    const transport: AgentTransport = {
      protocol: "a2a",
      send: async (_agentUrl, request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    };
    const outbound: MessageOutboundEvent[] = [];
    const runtime = new OpenClawPluginRuntime({
      config: {
        loadConfig: () => ({ channels: {} }) as never,
        writeConfigFile: async () => {},
      },
    });
    const connection = new Connection({
      agentClient: new AgentClient({
        agentUrl: "http://agent-1",
        protocol: "a2a",
        transport,
      }),
      binding,
      runtime,
      callbacks: {
        emitMessageOutbound: (event) => outbound.push(event),
      },
    });
    connection.listen();

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        ChannelType: "feishu",
        AccountId: "default",
        SessionKey: "session-1",
      } as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
    assert.deepEqual(outbound, [
      {
        accountId: "default",
        agentUrl: "http://agent-1",
        channelType: "feishu",
        sessionKey: "session-1",
        replyText: "echo: hello",
      },
    ]);
  });
});

describe("ConnectionManager", () => {
  test("does not require post-construction initialize wiring", () => {
    assert.equal(Object.hasOwn(ConnectionManager.prototype, "initialize"), false);
  });
});
