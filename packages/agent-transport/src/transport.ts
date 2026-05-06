export interface AgentRequest {
  userMessage: string;
  sessionKey: string;
  accountId: string;
}

export interface AgentResponse {
  text: string;
}

export type AgentResponseStreamEventKind = "partial" | "block" | "final";

export interface AgentResponseStreamEvent {
  kind: AgentResponseStreamEventKind;
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

export class AgentClient {
  readonly protocol: AgentProtocol;

  constructor(private readonly options: AgentClientOptions) {
    this.protocol = options.protocol;
  }

  send(request: AgentRequest): Promise<AgentResponse> {
    return this.options.transport.send(request);
  }

  stream(request: AgentRequest): AsyncIterable<AgentResponseStreamEvent> {
    if (this.options.transport.stream) {
      return this.options.transport.stream(request);
    }

    return this.streamFinalResponse(request);
  }

  async start(): Promise<void> {
    await this.options.transport.start?.();
  }

  async stop(): Promise<void> {
    await this.options.transport.stop?.();
  }

  private async *streamFinalResponse(
    request: AgentRequest,
  ): AsyncIterable<AgentResponseStreamEvent> {
    const response = await this.send(request);
    yield { kind: "final", text: response.text };
  }
}

export interface AgentTransport {
  readonly protocol: AgentProtocol;
  send(request: AgentRequest): Promise<AgentResponse>;
  stream?(request: AgentRequest): AsyncIterable<AgentResponseStreamEvent>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface AgentTransportFactory {
  readonly protocol: AgentProtocol;
  create(
    config: AgentProtocolConfig,
    context?: AgentTransportContext,
  ): AgentTransport;
}

export interface AgentTransportContext {
  readonly agentName?: string;
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
