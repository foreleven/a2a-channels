/** Centralizes channel id aliases used at the gateway/runtime boundary. */
export class ChannelTypeRegistry {
  private readonly aliases = new Map<string, string>([
    ["feishu", "feishu"],
    ["lark", "feishu"],
    ["wechat", "openclaw-weixin"],
    ["weixin", "openclaw-weixin"],
    ["openclaw-weixin", "openclaw-weixin"],
  ]);

  canonicalize(channelType: string): string {
    return this.aliases.get(channelType) ?? channelType;
  }

  aliasesFor(canonicalChannelType: string): string[] {
    const aliases: string[] = [];
    for (const [alias, canonical] of this.aliases.entries()) {
      if (canonical === canonicalChannelType && alias !== canonicalChannelType) {
        aliases.push(alias);
      }
    }
    return aliases;
  }
}

export const channelTypeRegistry = new ChannelTypeRegistry();
