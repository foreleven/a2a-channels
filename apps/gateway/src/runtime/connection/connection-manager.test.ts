import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentClient,
  type AgentRequest,
  type AgentTransport,
} from "@a2a-channels/agent-transport";
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

function createAgentClient(
  displayTarget: string,
  send: (request: AgentRequest) => Promise<{ text: string }> = async () => ({
    text: "ok",
  }),
): AgentClient {
  const transport: AgentTransport = {
    protocol: "a2a",
    displayTarget,
    send,
  };
  return new AgentClient({
    displayTarget,
    protocol: "a2a",
    transport,
  });
}

describe("Connection", () => {
  test("marks connected when a channel binding reports a generic status update", async () => {
    const statuses: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1"),
      binding,
      callbacks: {
        onConnectionStatus: (event) => statuses.push(event.status),
      },
    });
    const host = {
      startChannelBinding: async (
        _binding: ChannelBindingSnapshot,
        signal: AbortSignal,
        callbacks: {
          onStatus?: (status: { accountId: string; port: null }) => void;
        },
      ) => {
        callbacks.onStatus?.({ accountId: "default", port: null });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    connection.start(host as never);
    await waitFor(() => statuses.includes("connected"));
    await connection.stop();

    assert.deepEqual(statuses, ["connecting", "connected"]);
  });

  test("handles inbound messages when called directly", async () => {
    const sentMessages: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1", async (request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
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

  test("matches channel account across channel type aliases", async () => {
    const sentMessages: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1", async (request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      }),
      binding: {
        ...binding,
        channelType: "wechat",
        accountId: "911b9b000589-im-bot",
      },
    });

    const response = await connection.handleInbound({
      accountId: "911b9b000589-im-bot",
      channelType: "openclaw-weixin",
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
    const agentClient = createAgentClient(
      "http://agent-1",
      async (request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    );
    const runtime = createRuntime();
    const manager = new ConnectionManager(null as never, runtime, null as never);
    const connection = new Connection({
      agentClient,
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
    const agentClient = createAgentClient(
      "http://agent-1",
      async (request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    );
    const runtime = createRuntime();
    const manager = new ConnectionManager(null as never, runtime, null as never);
    const matchingConnection = new Connection({
      agentClient,
      binding,
    });
    const unrelatedConnection = new Connection({
      agentClient: createAgentClient("http://agent-2"),
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

  test("routes runtime reply events across channel type aliases", async () => {
    const sentMessages: string[] = [];
    const agentClient = createAgentClient(
      "http://agent-1",
      async (request) => {
        sentMessages.push(request.userMessage);
        return { text: `echo: ${request.userMessage}` };
      },
    );
    const runtime = createRuntime();
    const manager = new ConnectionManager(null as never, runtime, null as never);
    const connection = new Connection({
      agentClient,
      binding: {
        ...binding,
        channelType: "wechat",
        accountId: "911b9b000589-im-bot",
      },
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        ChannelType: "openclaw-weixin",
        AccountId: "911b9b000589-im-bot",
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

  test("OpenClawPluginRuntime supports OpenClaw channel turn dispatch", async () => {
    const runtime = createRuntime().asPluginRuntime();
    let recordedSessionKey: string | undefined;
    let dispatchCalled = false;

    const result = await runtime.channel.turn.run({
      channel: "feishu",
      accountId: "default",
      raw: { messageId: "message-1" },
      adapter: {
        ingest: () => ({
          id: "message-1",
          rawText: "hello",
          raw: { messageId: "message-1" },
        }),
        resolveTurn: () => ({
          channel: "feishu",
          accountId: "default",
          routeSessionKey: "session-1",
          storePath: "/tmp/a2a-test-sessions",
          ctxPayload: {
            BodyForAgent: "hello",
            AccountId: "default",
            SessionKey: "session-1",
          } as never,
          recordInboundSession: async ({ sessionKey }) => {
            recordedSessionKey = sessionKey;
          },
          runDispatch: async () => {
            dispatchCalled = true;
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 1 },
            };
          },
        }),
      },
    });

    assert.equal(recordedSessionKey, "session-1");
    assert.equal(dispatchCalled, true);
    assert.deepEqual(result, {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: {
        BodyForAgent: "hello",
        AccountId: "default",
        SessionKey: "session-1",
      },
      routeSessionKey: "session-1",
      dispatchResult: {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
      },
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

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for assertion");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
