import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  SessionKey,
  type ChannelBindingSnapshot,
} from "@agent-relay/domain";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

import { RuntimeOwnershipState } from "./ownership-state.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";

function createBinding(
  overrides: Partial<ChannelBindingSnapshot> = {},
): ChannelBindingSnapshot {
  return {
    id: "binding-1",
    name: "Telegram Binding",
    channelType: "telegram",
    accountId: "default",
    channelConfig: {
      botToken: "token-1",
      allowedUpdates: ["message"],
    },
    agentId: "agent-1",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("RuntimeOpenClawConfigProjection", () => {
  test("projects non-Feishu channel config without interpreting plugin-owned fields", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(createBinding());

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["telegram"], {
      bindingId: "binding-1",
      botToken: "token-1",
      allowedUpdates: ["message"],
      enabled: true,
    });
  });

  test("projects named accounts under the channel accounts map", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-2",
        accountId: "alerts",
        channelConfig: {
          botToken: "token-2",
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["telegram"], {
      accounts: {
        alerts: {
          bindingId: "binding-2",
          botToken: "token-2",
          enabled: true,
        },
      },
    });
  });

  test("buildScopedConfig does not replace the owned runtime projection", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-default",
        accountId: "default",
        channelConfig: { botToken: "token-default" },
      }),
    );
    ownershipState.attachBinding(
      createBinding({
        id: "binding-alerts",
        accountId: "alerts",
        channelConfig: { botToken: "token-alerts" },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);
    const before = structuredClone(projection.getConfig());

    const scoped = projection.buildScopedConfig([
      createBinding({
        id: "binding-default",
        accountId: "default",
        channelConfig: { botToken: "token-default" },
      }),
    ]);

    assert.deepEqual(scoped.channels?.["telegram"], {
      bindingId: "binding-default",
      botToken: "token-default",
      enabled: true,
    });
    assert.deepEqual(projection.getConfig(), before);
    assert.deepEqual(projection.getConfig().channels?.["telegram"], {
      bindingId: "binding-default",
      botToken: "token-default",
      enabled: true,
      accounts: {
        alerts: {
          bindingId: "binding-alerts",
          botToken: "token-alerts",
          enabled: true,
        },
      },
    });
  });

  test("projects WeChat aliases into the OpenClaw Weixin plugin channel key", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-wechat",
        channelType: "wechat",
        accountId: "default",
        channelConfig: {
          token: "token-1",
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["openclaw-weixin"], {
      bindingId: "binding-wechat",
      token: "token-1",
      enabled: true,
    });
    assert.equal(projection.getConfig().channels?.["wechat"], undefined);
  });

  test("projects gateway agents and route bindings for OpenClaw routing", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "feishu",
        accountId: "default",
        agentId: "agent-feishu",
      }),
    );
    ownershipState.attachBinding(
      createBinding({
        id: "binding-wechat",
        channelType: "wechat",
        accountId: "wechat-account",
        agentId: "agent-wechat",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);
    const config = projection.getConfig();

    assert.deepEqual(config.agents?.list, [
      { id: "agent-feishu", name: "agent-feishu" },
      { id: "agent-wechat", name: "agent-wechat" },
    ]);
    assert.deepEqual(config.bindings, [
      {
        type: "route",
        agentId: "agent-feishu",
        comment: "gateway binding binding-feishu",
        match: {
          channel: "feishu",
          accountId: "default",
        },
        session: {
          dmScope: "per-account-channel-peer",
        },
      },
      {
        type: "route",
        agentId: "agent-wechat",
        comment: "gateway binding binding-wechat",
        match: {
          channel: "openclaw-weixin",
          accountId: "wechat-account",
        },
        session: {
          dmScope: "per-account-channel-peer",
        },
      },
    ]);
    assert.deepEqual(config.session, {
      dmScope: "per-account-channel-peer",
    });
  });

  test("routes direct Feishu and WeChat sessions away from agent:main:main", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "feishu",
        accountId: "default",
        agentId: "agent-feishu",
      }),
    );
    ownershipState.attachBinding(
      createBinding({
        id: "binding-wechat",
        channelType: "wechat",
        accountId: "wechat-account",
        agentId: "agent-wechat",
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);
    const config = projection.getConfig();
    const feishuRoute = resolveAgentRoute({
      cfg: config,
      channel: "feishu",
      accountId: "default",
      peer: { kind: "direct", id: "ou_user_1" },
    });
    const wechatRoute = resolveAgentRoute({
      cfg: config,
      channel: "openclaw-weixin",
      accountId: "wechat-account",
      peer: { kind: "direct", id: "wx_user_1" },
    });

    assert.equal(feishuRoute.agentId, "agent-feishu");
    assert.equal(
      feishuRoute.sessionKey,
      SessionKey.forPeer({
        agentId: "agent-feishu",
        channel: "feishu",
        accountId: "default",
        peerKind: "direct",
        peerId: "ou_user_1",
      }).toString(),
    );
    assert.equal(wechatRoute.agentId, "agent-wechat");
    assert.equal(
      wechatRoute.sessionKey,
      SessionKey.forPeer({
        agentId: "agent-wechat",
        channel: "openclaw-weixin",
        accountId: "wechat-account",
        peerKind: "direct",
        peerId: "wx_user_1",
      }).toString(),
    );
  });

  test("defaults Feishu bindings to streaming cards and thread replies", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "feishu",
        channelConfig: {
          appId: "cli_1",
          appSecret: "sec_1",
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["feishu"], {
      appId: "cli_1",
      appSecret: "sec_1",
      bindingId: "binding-feishu",
      enabled: true,
      streaming: true,
      groupPolicy: "open",
      requireMention: true,
      replyInThread: "enabled",
    });
  });

  test("preserves explicit Feishu streaming overrides", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "lark",
        channelConfig: {
          appId: "cli_1",
          appSecret: "sec_1",
          streaming: false,
          replyInThread: "disabled",
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["feishu"], {
      appId: "cli_1",
      appSecret: "sec_1",
      bindingId: "binding-feishu",
      enabled: true,
      streaming: false,
      groupPolicy: "open",
      requireMention: true,
      replyInThread: "disabled",
    });
  });

  test("normalizes boolean Feishu thread reply config for OpenClaw", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "feishu",
        channelConfig: {
          appId: "cli_1",
          appSecret: "sec_1",
          replyInThread: true,
          groups: {
            "oc_1": {
              replyInThread: false,
            },
            "oc_2": {
              replyInThread: true,
            },
          },
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["feishu"], {
      appId: "cli_1",
      appSecret: "sec_1",
      bindingId: "binding-feishu",
      enabled: true,
      streaming: true,
      groupPolicy: "open",
      requireMention: true,
      replyInThread: "enabled",
      groups: {
        "oc_1": {
          replyInThread: "disabled",
        },
        "oc_2": {
          replyInThread: "enabled",
        },
      },
    });
  });

  test("keeps Feishu projection tolerant of legacy and invalid typed values", () => {
    const ownershipState = new RuntimeOwnershipState();
    ownershipState.attachBinding(
      createBinding({
        id: "binding-feishu",
        channelType: "feishu",
        channelConfig: {
          appId: "cli_1",
          appSecret: "sec_1",
          streaming: "yes",
          groupPolicy: "allowall",
          requireMention: "true",
          replyInThread: "bad-value",
        },
      }),
    );

    const projection = new RuntimeOpenClawConfigProjection(ownershipState);

    assert.deepEqual(projection.getConfig().channels?.["feishu"], {
      appId: "cli_1",
      appSecret: "sec_1",
      bindingId: "binding-feishu",
      enabled: true,
      streaming: true,
      groupPolicy: "open",
      requireMention: true,
      replyInThread: "enabled",
    });
  });
});
