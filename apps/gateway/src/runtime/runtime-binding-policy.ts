import { injectable } from "inversify";
import type { ChannelBinding } from "@a2a-channels/core";

@injectable()
export class RuntimeBindingPolicy {
  isRunnableBinding(binding: ChannelBinding): boolean {
    if (binding.channelType !== "feishu" && binding.channelType !== "lark") {
      return true;
    }

    const config = binding.channelConfig as {
      appId?: unknown;
      appSecret?: unknown;
    };

    return (
      typeof config.appId === "string" &&
      config.appId.trim().length > 0 &&
      typeof config.appSecret === "string" &&
      config.appSecret.trim().length > 0
    );
  }
}
