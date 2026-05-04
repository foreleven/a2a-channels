import { inject, injectable } from "inversify";

import {
  OpenClawPluginHost,
  type ChannelQrLoginStartParams,
  type ChannelQrLoginStartResult,
  type ChannelQrLoginWaitParams,
  type ChannelQrLoginWaitResult,
} from "@a2a-channels/openclaw-compat";
import QRCode from "qrcode";

export class UnsupportedChannelQrAuthError extends Error {
  constructor(readonly channelType: string) {
    super(`Channel QR login is not supported for ${channelType}`);
  }
}

export interface ChannelQrAuthGateway {
  startChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult>;
  waitForChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult>;
}

@injectable()
export class ChannelAuthService {
  constructor(
    @inject(OpenClawPluginHost)
    private readonly gateway: ChannelQrAuthGateway,
  ) {}

  async startQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult> {
    if (isFeishuChannel(channelType)) {
      return this.startFeishuSetupQrLogin();
    }

    try {
      return await this.gateway.startChannelQrLogin(channelType, params);
    } catch (err) {
      this.rethrowQrSupportError(channelType, err);
    }
  }

  async waitForQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    if (isFeishuChannel(channelType)) {
      return this.waitForFeishuSetupQrLogin(params);
    }

    try {
      return await this.gateway.waitForChannelQrLogin(channelType, params);
    } catch (err) {
      this.rethrowQrSupportError(channelType, err);
    }
  }

  private rethrowQrSupportError(channelType: string, err: unknown): never {
    if (
      err instanceof Error &&
      err.message.startsWith("Channel QR login is not supported")
    ) {
      throw new UnsupportedChannelQrAuthError(channelType);
    }
    throw err;
  }

  private async startFeishuSetupQrLogin(): Promise<ChannelQrLoginStartResult> {
    const registration =
      await import("@openclaw/feishu/src/app-registration.js");
    await registration.initAppRegistration("feishu");
    const begin = await registration.beginAppRegistration("feishu");
    const qrDataUrl = await QRCode.toDataURL(begin.qrUrl, {
      margin: 1,
      width: 256,
    });

    return {
      qrDataUrl,
      message: "Scan with Feishu/Lark to create and authorize the app.",
      sessionKey: encodeFeishuSetupSession({
        deviceCode: begin.deviceCode,
        expireIn: begin.expireIn,
        interval: begin.interval,
      }),
    };
  }

  private async waitForFeishuSetupQrLogin(
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const session = decodeFeishuSetupSession(params.sessionKey);
    const registration =
      await import("@openclaw/feishu/src/app-registration.js");
    const expireIn = Math.min(
      session.expireIn,
      Math.max(
        Math.ceil((params.timeoutMs ?? 60_000) / 1000),
        session.interval,
      ),
    );
    const outcome = await registration.pollAppRegistration({
      deviceCode: session.deviceCode,
      interval: session.interval,
      expireIn,
      initialDomain: "feishu",
      tp: "ob_app",
    });

    if (outcome.status !== "success") {
      return {
        connected: false,
        message: `Feishu scan status: ${outcome.status}`,
      };
    }

    const result = outcome.result;

    console.log("result", result);
    return {
      connected: true,
      message: "Feishu app authorization completed.",
      accountId: "default",
      channelConfig: {
        appId: result.appId,
        appSecret: result.appSecret,
        allowFrom: result.openId ? [result.openId] : ["*"],
      },
    };
  }
}

function isFeishuChannel(channelType: string): boolean {
  return channelType === "feishu" || channelType === "lark";
}

interface FeishuSetupSession {
  deviceCode: string;
  interval: number;
  expireIn: number;
}

function encodeFeishuSetupSession(session: FeishuSetupSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeFeishuSetupSession(rawSessionKey?: string): FeishuSetupSession {
  if (!rawSessionKey) {
    throw new Error("Feishu setup session is missing.");
  }
  const parsed = JSON.parse(
    Buffer.from(rawSessionKey, "base64url").toString("utf8"),
  ) as Partial<FeishuSetupSession>;
  if (!parsed.deviceCode || !parsed.interval || !parsed.expireIn) {
    throw new Error("Feishu setup session is invalid.");
  }
  return {
    deviceCode: parsed.deviceCode,
    interval: parsed.interval,
    expireIn: parsed.expireIn,
  };
}
