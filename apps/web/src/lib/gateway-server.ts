import type {
  AgentConfig,
  ChannelMessage,
  ChannelBinding,
  RuntimeChannelStatus,
} from "./api";

export class GatewayServerClient {
  private readonly baseUrl =
    process.env["GATEWAY_URL"] ??
    process.env["NEXT_PUBLIC_GATEWAY_URL"] ??
    "http://localhost:7890";

  constructor(private readonly authCookie?: string | null) {}

  async listChannels(): Promise<ChannelBinding[]> {
    return this.get<ChannelBinding[]>("/api/channels");
  }

  async listAgents(): Promise<AgentConfig[]> {
    return this.get<AgentConfig[]>("/api/agents");
  }

  async listMessages(limit = 25): Promise<ChannelMessage[]> {
    return this.get<ChannelMessage[]>(`/api/messages?limit=${limit}`);
  }

  async listRuntimeChannelStatuses(): Promise<RuntimeChannelStatus[]> {
    return this.get<RuntimeChannelStatus[]>("/api/runtime/connections");
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      cache: "no-store",
      headers: this.authCookie ? { Cookie: this.authCookie } : undefined,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }
}
