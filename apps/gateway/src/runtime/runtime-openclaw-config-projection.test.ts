import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ChannelBindingSnapshot } from "@agent-relay/domain";

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
