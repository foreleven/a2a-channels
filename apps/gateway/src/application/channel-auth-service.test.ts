import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ChannelAuthService,
  UnsupportedChannelQrAuthError,
} from "./channel-auth-service.js";

describe("ChannelAuthService", () => {
  test("starts and waits for QR login through the registered channel gateway", async () => {
    const calls: string[] = [];
    const service = new ChannelAuthService({
      startChannelQrLogin: async (channelType, params) => {
        calls.push(`start:${channelType}:${params.accountId}:${params.force}`);
        return {
          qrDataUrl: "data:image/png;base64,abc",
          message: "scan",
          sessionKey: "session-1",
        };
      },
      waitForChannelQrLogin: async (channelType, params) => {
        calls.push(
          `wait:${channelType}:${params.accountId}:${params.sessionKey}:${params.timeoutMs}`,
        );
        return {
          connected: true,
          message: "connected",
          accountId: "wx-account",
        };
      },
    });

    const start = await service.startQrLogin("wechat", {
      accountId: "default",
      force: true,
    });
    const wait = await service.waitForQrLogin("wechat", {
      accountId: "default",
      sessionKey: start.sessionKey,
      timeoutMs: 1500,
    });

    assert.deepEqual(calls, [
      "start:wechat:default:true",
      "wait:wechat:default:session-1:1500",
    ]);
    assert.equal(start.qrDataUrl, "data:image/png;base64,abc");
    assert.equal(wait.connected, true);
    assert.equal(wait.accountId, "wx-account");
  });

  test("rejects channels that do not expose QR login", async () => {
    const service = new ChannelAuthService({
      startChannelQrLogin: async () => {
        throw new Error("Channel QR login is not supported for feishu");
      },
      waitForChannelQrLogin: async () => {
        throw new Error("unused");
      },
    });

    await assert.rejects(
      () => service.startQrLogin("slack", {}),
      UnsupportedChannelQrAuthError,
    );
  });
});
