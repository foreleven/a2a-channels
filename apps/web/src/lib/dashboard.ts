import type { AgentConfig, ChannelBinding } from "./api";

export interface DashboardSnapshot {
  channels: ChannelBinding[];
  agents: AgentConfig[];
  totals: {
    channels: number;
    enabledChannels: number;
    disabledChannels: number;
    agents: number;
    unassignedAgents: number;
  };
  channelTypes: Array<{ name: string; count: number }>;
  recentBindings: ChannelBinding[];
  generatedAt: string;
}

export class DashboardSnapshotFactory {
  create(channels: ChannelBinding[], agents: AgentConfig[]): DashboardSnapshot {
    const enabledChannels = channels.filter((channel) => channel.enabled).length;
    const assignedAgentIds = new Set(channels.map((channel) => channel.agentId));
    const channelTypeCounts = channels.reduce<Map<string, number>>(
      (counts, channel) =>
        counts.set(channel.channelType, (counts.get(channel.channelType) ?? 0) + 1),
      new Map(),
    );

    return {
      channels,
      agents,
      totals: {
        channels: channels.length,
        enabledChannels,
        disabledChannels: channels.length - enabledChannels,
        agents: agents.length,
        unassignedAgents: agents.filter((agent) => !assignedAgentIds.has(agent.id))
          .length,
      },
      channelTypes: Array.from(channelTypeCounts, ([name, count]) => ({
        name,
        count,
      })).sort((a, b) => b.count - a.count),
      recentBindings: [...channels]
        .sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )
        .slice(0, 5),
      generatedAt: new Date().toISOString(),
    };
  }
}

export class DashboardEventStream {
  private source: EventSource | null = null;

  constructor(private readonly url = "/api/dashboard/events") {}

  connect(options: {
    onSnapshot(snapshot: DashboardSnapshot): void;
    onError(error: string): void;
    onOpen?(): void;
  }) {
    this.close();
    this.source = new EventSource(this.url);
    this.source.onopen = () => options.onOpen?.();
    this.source.onerror = () =>
      options.onError("Dashboard event stream is disconnected.");
    this.source.addEventListener("snapshot", (event) => {
      options.onSnapshot(JSON.parse((event as MessageEvent).data));
    });
    this.source.addEventListener("error-state", (event) => {
      options.onError(JSON.parse((event as MessageEvent).data));
    });
  }

  close() {
    this.source?.close();
    this.source = null;
  }
}
