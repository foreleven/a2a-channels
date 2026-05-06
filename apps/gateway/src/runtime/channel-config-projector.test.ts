import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelBindingSnapshot } from "@agent-relay/domain";

import { GenericChannelConfigProjector } from "./channel-config-projector.js";

function makeBinding(
  overrides: Partial<ChannelBindingSnapshot> = {},
): ChannelBindingSnapshot {
  return {
    id: "binding-1",
    name: "Test Binding",
    channelType: "telegram",
    accountId: "default",
    channelConfig: { botToken: "tok-1" },
    agentId: "agent-1",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("GenericChannelConfigProjector", () => {
  describe("project", () => {
    test("returns null for a disabled binding", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(makeBinding({ enabled: false }));
      assert.equal(result, null);
    });

    test("uses the binding accountId in the projected config", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(makeBinding({ accountId: "my-account" }));

      assert.equal(result?.accountId, "my-account");
    });

    test("maps telegram channel type to the telegram channel key", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(makeBinding({ channelType: "telegram" }));

      assert.equal(result?.channelKey, "telegram");
    });

    test("canonicalizes lark to feishu channel key", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(
        makeBinding({
          channelType: "lark",
          channelConfig: { appId: "cli_1", appSecret: "sec_1" },
        }),
      );

      assert.equal(result?.channelKey, "feishu");
    });

    test("canonicalizes wechat to openclaw-weixin channel key", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(
        makeBinding({ channelType: "wechat", channelConfig: { token: "tok-x" } }),
      );

      assert.equal(result?.channelKey, "openclaw-weixin");
    });

    test("injects bindingId and enabled=true into the projected config", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(makeBinding({ id: "binding-42" }));

      assert.equal(result?.config.bindingId, "binding-42");
      assert.equal(result?.config.enabled, true);
    });

    test("preserves plugin-owned channel config fields", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(
        makeBinding({ channelConfig: { botToken: "abc123", allowedUpdates: ["message"] } }),
      );

      assert.equal(result?.config.botToken, "abc123");
      assert.deepEqual(result?.config.allowedUpdates, ["message"]);
    });

    test("applies Feishu-specific defaults for feishu channel type", () => {
      const projector = new GenericChannelConfigProjector();
      const result = projector.project(
        makeBinding({
          channelType: "feishu",
          channelConfig: { appId: "cli_1", appSecret: "sec_1" },
        }),
      );

      // Feishu schema adds streaming, groupPolicy, requireMention, replyInThread defaults
      assert.equal(result?.config.streaming, true);
      assert.equal(result?.config.requireMention, true);
      assert.equal(result?.config.replyInThread, "enabled");
    });
  });
});
