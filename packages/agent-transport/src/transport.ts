export interface AgentRequest {
  userMessage: string;
  sessionKey?: string;
  accountId?: string;
}

export interface AgentResponse {
  text: string;
}

export type AgentProtocol = "a2a" | "acp";

export interface A2AAgentConfig {
  readonly url: string;
}

export interface ACPStdioAgentConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly permission?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always";
  readonly timeoutMs?: number;
}

export type ACPAgentConfig = ACPStdioAgentConfig;
export type AgentProtocolConfig = A2AAgentConfig | ACPAgentConfig;

export interface AgentClientOptions {
  protocol: AgentProtocol;
  transport: AgentTransport;
}

/**
 * Builds a session/context identifier that incorporates the account ID so that
 * different accounts are always isolated to separate sessions, even when the
 * channel-level session key happens to be the same across accounts.
 *
 * When no accountId is present the raw sessionKey is returned unchanged so
 * that callers without account context continue to work as before.
 */
export function buildIsolatedSessionKey(
  accountId: string | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (accountId) {
    return `${accountId}:${sessionKey ?? "default"}`;
  }
  return sessionKey;
}

export class AgentClient {
  readonly protocol: AgentProtocol;

  constructor(private readonly options: AgentClientOptions) {
    this.protocol = options.protocol;
  }

  send(request: AgentRequest): Promise<AgentResponse> {
    return this.options.transport.send(request);
  }

  async start(): Promise<void> {
    await this.options.transport.start?.();
  }

  async stop(): Promise<void> {
    await this.options.transport.stop?.();
  }
}

export interface AgentTransport {
  readonly protocol: AgentProtocol;
  send(request: AgentRequest): Promise<AgentResponse>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface AgentTransportFactory {
  readonly protocol: AgentProtocol;
  create(config: AgentProtocolConfig): AgentTransport;
}

/** Protocol-keyed registry for resolving agent transport implementations. */
export class TransportRegistry {
  private readonly factories = new Map<AgentProtocol, AgentTransportFactory>();

  register(factory: AgentTransportFactory): this {
    this.factories.set(factory.protocol, factory);
    return this;
  }

  resolve(protocol: AgentProtocol): AgentTransportFactory {
    const factory =
      this.factories.get(protocol) ?? this.factories.get("a2a");
    if (!factory) {
      throw new Error(
        `No transport registered for protocol "${protocol}" and no "a2a" fallback available.`,
      );
    }

    return factory;
  }

  has(protocol: AgentProtocol): boolean {
    return this.factories.has(protocol);
  }
}
