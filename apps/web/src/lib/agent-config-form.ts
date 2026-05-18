import type {
  AgentConfig,
  A2AContextIdStrategy,
  AgentProtocol,
  AgentProtocolConfig,
  ACPStdioAgentConfig,
  ACPRemoteExecutorType,
  WsTunnelAgentConfig,
} from "@/lib/api";

export type AgentPermission = NonNullable<ACPStdioAgentConfig["permission"]>;
export type AgentContextIdStrategy = A2AContextIdStrategy;

export interface AgentProtocolOption {
  value: AgentProtocol;
  routeSegment?: string;
  label: string;
  summary: string;
  badge: string;
}

export interface AgentConfigFormState {
  name: string;
  protocol: AgentProtocol;
  url: string;
  contextIdStrategy: AgentContextIdStrategy;
  command: string;
  args: string;
  cwd: string;
  permission: "" | AgentPermission;
  timeoutMs: string;
  description: string;
  // ACP Remote executor fields, persisted as ws-tunnel transport config.
  executorType: ACPRemoteExecutorType;
}

export type AgentConfigFormField = keyof AgentConfigFormState;
export type AgentConfigFormValidation = Partial<
  Record<AgentConfigFormField, string>
>;

export const DEFAULT_AGENT_PROTOCOL: AgentProtocol = "a2a";

export const AGENT_PROTOCOL_OPTIONS: AgentProtocolOption[] = [
  {
    value: "a2a",
    label: "A2A JSON-RPC",
    badge: "A2A",
    summary: "HTTP endpoint for a remote A2A-compatible JSON-RPC agent.",
  },
  {
    value: "acp",
    label: "ACP stdio",
    badge: "ACP",
    summary: "Local Agent Client Protocol process launched by the gateway.",
  },
  {
    value: "ws-tunnel",
    routeSegment: "acp-remote",
    label: "ACP Remote",
    badge: "WS",
    summary:
      "Remote ACP runner connects from the agent host to the gateway through the WebSocket relay.",
  },
];

export const ACP_PERMISSION_OPTIONS: Array<{
  value: AgentPermission;
  label: string;
}> = [
  { value: "reject_once", label: "Reject once" },
  { value: "allow_once", label: "Allow once" },
  { value: "allow_always", label: "Allow always" },
  { value: "reject_always", label: "Reject always" },
];

export const EMPTY_AGENT_FORM: AgentConfigFormState = {
  name: "",
  protocol: DEFAULT_AGENT_PROTOCOL,
  url: "",
  contextIdStrategy: "client-provided",
  command: "",
  args: "",
  cwd: "",
  permission: "",
  timeoutMs: "",
  description: "",
  executorType: "claude-code",
};

const AGENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export class AgentConfigFormMapper {
  toPayload(
    form: AgentConfigFormState,
  ): Omit<AgentConfig, "id" | "createdAt"> {
    return {
      name: form.name.trim(),
      protocol: form.protocol,
      config: this.toProtocolConfig(form),
      ...(form.description.trim()
        ? { description: form.description.trim() }
        : {}),
    };
  }

  fromAgent(agent: AgentConfig): AgentConfigFormState {
    const config = agent.config;
    if ("transport" in config && config.transport === "ws-tunnel") {
      const ws = config as WsTunnelAgentConfig;
      const executor = ws.executor;
      return {
        ...EMPTY_AGENT_FORM,
        name: agent.name,
        protocol: "ws-tunnel",
        description: agent.description ?? "",
        executorType: executor.type,
        command: executor.command,
        args: (executor.args ?? []).join("\n"),
        cwd: executor.cwd ?? "",
        permission: executor.permission ?? "",
        timeoutMs:
          executor.timeoutMs != null
            ? String(executor.timeoutMs)
            : ws.timeoutMs != null
              ? String(ws.timeoutMs)
              : "",
      };
    }

    if ("transport" in config) {
      const acp = config as ACPStdioAgentConfig;
      return {
        ...EMPTY_AGENT_FORM,
        name: agent.name,
        protocol: "acp",
        command: acp.command,
        args: (acp.args ?? []).join("\n"),
        cwd: acp.cwd ?? "",
        permission: acp.permission ?? "",
        timeoutMs: acp.timeoutMs ? String(acp.timeoutMs) : "",
        description: agent.description ?? "",
      };
    }

    return {
      ...EMPTY_AGENT_FORM,
      name: agent.name,
      protocol: "a2a",
      url: config.url,
      contextIdStrategy: config.contextIdStrategy ?? "client-provided",
      description: agent.description ?? "",
    };
  }

  canSubmit(form: AgentConfigFormState): boolean {
    return Object.keys(this.validate(form)).length === 0;
  }

  validate(form: AgentConfigFormState): AgentConfigFormValidation {
    const errors: AgentConfigFormValidation = {};
    const name = form.name.trim();

    if (!name) {
      errors.name = "Name is required.";
    } else if (!isFolderSafeAgentName(name)) {
      errors.name =
        "Use only letters, numbers, dots, underscores, and hyphens.";
    }

    if (form.protocol === "acp") {
      if (!form.command.trim()) {
        errors.command = "Command is required.";
      }
      if (!this.hasValidTimeout(form.timeoutMs)) {
        errors.timeoutMs = "Use a positive integer.";
      }
      return errors;
    }

    if (form.protocol === "ws-tunnel") {
      if (!form.command.trim()) {
        errors.command = "Command is required.";
      }
      if (!this.hasValidTimeout(form.timeoutMs)) {
        errors.timeoutMs = "Use a positive integer.";
      }
      return errors;
    }

    if (!form.url.trim()) {
      errors.url = "A2A URL is required.";
    }

    return errors;
  }

  describeTarget(agent: AgentConfig): string {
    const config = agent.config;
    if ("transport" in config && config.transport === "ws-tunnel") {
      const ws = config as WsTunnelAgentConfig;
      return `${ws.executor.type} ACP -> ${this.buildCommandLine(
        ws.executor.command,
        ws.executor.args ?? [],
      )}`;
    }
    if ("transport" in config) {
      const acp = config as ACPStdioAgentConfig;
      return this.buildCommandLine(acp.command, acp.args ?? []);
    }
    return config.url;
  }

  transportLabel(config: AgentProtocolConfig): string {
    if (!("transport" in config)) return "";
    // ws-tunnel transport label is already conveyed by the protocol badge
    if (config.transport === "ws-tunnel") return "";
    return config.transport;
  }

  protocolOption(protocol: AgentProtocol): AgentProtocolOption {
    return (
      AGENT_PROTOCOL_OPTIONS.find((option) => option.value === protocol) ??
      AGENT_PROTOCOL_OPTIONS[0]
    );
  }

  protocolLabel(protocol: AgentProtocol): string {
    return this.protocolOption(protocol).label;
  }

  protocolBadge(protocol: AgentProtocol): string {
    return this.protocolOption(protocol).badge;
  }

  private toProtocolConfig(form: AgentConfigFormState): AgentProtocolConfig {
    if (form.protocol === "a2a") {
      return {
        url: form.url.trim(),
        contextIdStrategy: form.contextIdStrategy,
      };
    }

    if (form.protocol === "ws-tunnel") {
      const timeoutMs = this.parseTimeoutMs(form.timeoutMs);
      return {
        transport: "ws-tunnel",
        executor: {
          type: form.executorType,
          command: form.command.trim(),
          args: this.parseArgs(form.args),
          ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
          ...(form.permission ? { permission: form.permission } : {}),
          ...(timeoutMs != null ? { timeoutMs } : {}),
        },
        ...(timeoutMs != null ? { timeoutMs } : {}),
      };
    }

    const timeoutMs = this.parseTimeoutMs(form.timeoutMs);
    return {
      transport: "stdio",
      command: form.command.trim(),
      args: this.parseArgs(form.args),
      ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
      ...(form.permission ? { permission: form.permission } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
  }

  private parseArgs(value: string): string[] {
    return value
      .split("\n")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private buildCommandLine(command: string, args: readonly string[]): string {
    return [command, ...args].filter(Boolean).join(" ").trim();
  }

  private hasValidTimeout(value: string): boolean {
    return !value.trim() || this.parsePositiveInt(value) !== undefined;
  }

  private parseTimeoutMs(value: string): number | undefined {
    return this.parsePositiveInt(value);
  }

  private parsePositiveInt(value: string): number | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    return parsed;
  }
}

export function createAgentFormState(
  protocol: AgentProtocol = DEFAULT_AGENT_PROTOCOL,
): AgentConfigFormState {
  if (protocol === "ws-tunnel") {
    return {
      ...EMPTY_AGENT_FORM,
      protocol,
      command: "claude",
      args: "--experimental-acp",
      executorType: "claude-code",
    };
  }

  return {
    ...EMPTY_AGENT_FORM,
    protocol,
  };
}

export function normalizeAgentProtocol(
  protocol: string | undefined,
): AgentProtocol {
  if (protocol === "acp") return "acp";
  if (protocol === "acp-remote") return "ws-tunnel";
  if (protocol === "ws-tunnel") return "ws-tunnel";
  return "a2a";
}

export function agentCreateHref(protocol: string): string {
  const normalized = normalizeAgentProtocol(protocol);
  const option =
    AGENT_PROTOCOL_OPTIONS.find((entry) => entry.value === normalized) ??
    AGENT_PROTOCOL_OPTIONS[0];
  return `/agents/new/${option.routeSegment ?? option.value}`;
}

export function isFolderSafeAgentName(value: string): boolean {
  return (
    AGENT_NAME_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}
