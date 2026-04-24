export interface AgentRequest {
  userMessage: string;
  contextId?: string;
  accountId?: string;
}

export interface AgentResponse {
  text: string;
}

export interface AgentClientHandle {
  readonly agentUrl: string;
  readonly protocol: string;
  send(request: AgentRequest): Promise<AgentResponse>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface AgentTransport {
  readonly protocol: string;
  send(agentUrl: string, request: AgentRequest): Promise<AgentResponse>;
}

/** Protocol-keyed registry for resolving agent transport implementations. */
export class TransportRegistry {
  private readonly transports = new Map<string, AgentTransport>();

  register(transport: AgentTransport): this {
    this.transports.set(transport.protocol, transport);
    return this;
  }

  resolve(protocol: string): AgentTransport {
    const transport =
      this.transports.get(protocol) ?? this.transports.get("a2a");
    if (!transport) {
      throw new Error(
        `No transport registered for protocol "${protocol}" and no "a2a" fallback available.`,
      );
    }

    return transport;
  }

  has(protocol: string): boolean {
    return this.transports.has(protocol);
  }
}
