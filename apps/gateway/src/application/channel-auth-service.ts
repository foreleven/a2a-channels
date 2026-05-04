import { injectable, multiInject } from "inversify";

import {
  type ChannelQrLoginStartParams,
  type ChannelQrLoginStartResult,
  type ChannelQrLoginWaitParams,
  type ChannelQrLoginWaitResult,
} from "@a2a-channels/openclaw-compat";
import {
  ChannelQrLoginProviderToken,
  type ChannelQrLoginProvider,
} from "./channel-qr-login-provider.js";

export class UnsupportedChannelQrAuthError extends Error {
  constructor(readonly channelType: string) {
    super(`Channel QR login is not supported for ${channelType}`);
  }
}

@injectable()
export class ChannelAuthService {
  constructor(
    @multiInject(ChannelQrLoginProviderToken)
    private readonly providers: ChannelQrLoginProvider[],
  ) {}

  async startQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult> {
    const provider = this.resolveProvider(channelType);
    try {
      return await provider.start(channelType, params);
    } catch (err) {
      this.rethrowQrSupportError(channelType, err);
    }
  }

  async waitForQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const provider = this.resolveProvider(channelType);
    try {
      return await provider.wait(channelType, params);
    } catch (err) {
      this.rethrowQrSupportError(channelType, err);
    }
  }

  private resolveProvider(channelType: string): ChannelQrLoginProvider {
    const provider = this.providers.find((candidate) =>
      candidate.supports(channelType),
    );
    if (!provider) {
      throw new UnsupportedChannelQrAuthError(channelType);
    }
    return provider;
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
}
