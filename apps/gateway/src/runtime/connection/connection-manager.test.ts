import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AgentClient, type AgentTransport } from "@a2a-channels/agent-transport";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import { OpenClawPluginRuntime } from "@a2a-channels/openclaw-compat";

import { Connection, ConnectionManager } from "./index.js";

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
  test("handles inbound messages when called directly", async () => {
    const sentMessages: string[] = [];
    const transport: AgentTransport = {
      protocol: "a2a",
      send: async (_agentUrl, request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    };
    const connection = new Connection({
      agentClient: new AgentClient({
        agentUrl: "http://agent-1",
        protocol: "a2a",
        transport,
      }),
      binding,
    });

    const response = await connection.handleInbound({
      accountId: "default",
      channelType: "feishu",
      replyEvent: {
        type: "channel.reply.buffered.dispatch",
        ctx: {} as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      },
      sessionKey: "session-1",
      userMessage: "hello",
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });
});

describe("ConnectionManager", () => {
  test("does not require post-construction initialize wiring", () => {
    assert.equal(Object.hasOwn(ConnectionManager.prototype, "initialize"), false);
  });

  test("routes runtime reply events to its matching connection", async () => {
    const sentMessages: string[] = [];
    const transport: AgentTransport = {
      protocol: "a2a",
      send: async (_agentUrl, request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    };
    const runtime = createRuntime();
    const manager = new ConnectionManager(null as never, runtime, null as never);
    const connection = new Connection({
      agentClient: new AgentClient({
        agentUrl: "http://agent-1",
        protocol: "a2a",
        transport,
      }),
      binding,
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

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
  });

  test("routes by channel account without probing unrelated connections", async () => {
    const sentMessages: string[] = [];
    const transport: AgentTransport = {
      protocol: "a2a",
      send: async (_agentUrl, request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    };
    const runtime = createRuntime();
    const manager = new ConnectionManager(null as never, runtime, null as never);
    const matchingConnection = new Connection({
      agentClient: new AgentClient({
        agentUrl: "http://agent-1",
        protocol: "a2a",
        transport,
      }),
      binding,
    });
    const unrelatedConnection = new Connection({
      agentClient: new AgentClient({
        agentUrl: "http://agent-2",
        protocol: "a2a",
        transport,
      }),
      binding: {
        ...binding,
        id: "binding-2",
        accountId: "other-account",
      },
    });
    unrelatedConnection.handleInbound = async () => {
      throw new Error("unrelated connection should not be probed");
    };

    Reflect.get(manager, "trackConnection").call(manager, unrelatedConnection);
    Reflect.get(manager, "trackConnection").call(manager, matchingConnection);

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
  });

  test("completes dispatch replies when no connection owns the message", async () => {
    const runtime = createRuntime();
    new ConnectionManager(null as never, runtime, null as never);
    let markedComplete = false;
    let waitedForIdle = false;

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.dispatch",
      ctx: {
        BodyForAgent: "hello",
        ChannelType: "feishu",
        AccountId: "other-account",
        SessionKey: "session-1",
      } as never,
      cfg: {} as never,
      dispatcher: {
        markComplete: () => {
          markedComplete = true;
        },
        sendFinalReply: () => {},
        waitForIdle: async () => {
          waitedForIdle = true;
        },
      } as never,
    });

    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    assert.equal(markedComplete, true);
    assert.equal(waitedForIdle, true);
  });

  test("OpenClawPluginRuntime exposes dispatcher wiring instead of EventEmitter APIs", async () => {
    const runtime = createRuntime();

    assert.equal("on" in runtime, false);
    assert.equal("off" in runtime, false);
    assert.equal("emit" in runtime, false);

    runtime.setReplyEventDispatcher({
      dispatchReplyEvent: async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 7 },
      }),
    });

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {} as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 7 },
    });
  });
});

function createRuntime(): OpenClawPluginRuntime {
  return new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }) as never,
      writeConfigFile: async () => {},
    },
  });
}
