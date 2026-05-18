import { ACPTransport, type AgentTransport } from "@agent-relay/agent-transport";
import { SessionKey, type ChannelBindingSnapshot } from "@agent-relay/domain";
import type { RelayExecutorConfig, RunnerConfig } from "../types.js";

export interface RelayExecutor {
  execute(message: string): Promise<string>;
  stop(): Promise<void>;
}

export class ACPRemoteExecutor implements RelayExecutor {
  private readonly transport: AgentTransport;
  private readonly sessionKey: SessionKey;
  private readonly binding: ChannelBindingSnapshot;
  private protocolSessionId: string | undefined;

  constructor(
    private readonly runnerConfig: RunnerConfig,
    private readonly executorConfig: RelayExecutorConfig,
    transport?: AgentTransport,
  ) {
    this.transport =
      transport ??
      new ACPTransport().create(
        {
          transport: "stdio",
          command: executorConfig.command,
          args: executorConfig.args,
          cwd: executorConfig.cwd,
          permission: executorConfig.permission,
          timeoutMs: executorConfig.timeoutMs,
        },
        { agentName: runnerConfig.name },
      );
    this.sessionKey = SessionKey.main(runnerConfig.agentId, "relay-cli");
    this.binding = {
      id: `relay-cli:${runnerConfig.agentId}`,
      name: runnerConfig.name,
      channelType: "relay-cli",
      accountId: "relay-cli",
      channelConfig: {},
      agentId: runnerConfig.agentId,
      sessionIsolationStrategy: "sessionKey",
      enabled: true,
      createdAt: new Date(0).toISOString(),
    };
  }

  async execute(message: string): Promise<string> {
    await this.transport.start?.();
    const response = await this.transport.send(
      {
        message,
        accountId: "relay-cli",
        sessionKey: this.sessionKey,
        binding: this.binding,
      },
      { protocolSessionId: this.protocolSessionId },
    );

    if (response.protocolSessionId) {
      this.protocolSessionId = response.protocolSessionId;
    }

    return response.text;
  }

  stop(): Promise<void> {
    return this.transport.stop?.() ?? Promise.resolve();
  }
}

export function createRelayExecutor(config: RunnerConfig): RelayExecutor {
  return new ACPRemoteExecutor(config, config.executor);
}
