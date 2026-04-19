/**
 * Protocol-agnostic agent transport contract.
 *
 * Any protocol adapter (A2A, ACP, …) must implement AgentTransport.
 * The runtime dispatches through a concrete transport instance without
 * knowing the underlying protocol.
 */

export interface AgentRequest {
  userMessage: string;
  /** Conversation context identifier for stateful agents. */
  contextId?: string;
  /** Channel account that received the message, for agent-side routing. */
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
  /** Short protocol identifier, e.g. "a2a" or "acp". */
  readonly protocol: string;
  send(agentUrl: string, request: AgentRequest): Promise<AgentResponse>;
}

// ---------------------------------------------------------------------------
// Transport registry
// ---------------------------------------------------------------------------

/**
 * Registry that maps protocol identifiers to transport implementations.
 *
 * The gateway creates one shared instance, registers all supported transports
 * (A2A, ACP, …), and injects it into the plugin runtime so the runtime can
 * dispatch each message through the correct transport based on the agent's
 * configured protocol.
 */
export class TransportRegistry {
  private readonly transports = new Map<string, AgentTransport>();

  /** Register a transport. Overwrites any previously registered transport for the same protocol. */
  register(transport: AgentTransport): this {
    this.transports.set(transport.protocol, transport);
    return this;
  }

  /**
   * Resolve the transport for a protocol identifier.
   * Falls back to "a2a" if the requested protocol is not registered.
   * Throws if neither the requested protocol nor "a2a" is registered.
   */
  resolve(protocol: string): AgentTransport {
    const t = this.transports.get(protocol) ?? this.transports.get("a2a");
    if (!t) {
      throw new Error(
        `No transport registered for protocol "${protocol}" and no "a2a" fallback available.`,
      );
    }
    return t;
  }

  /** Returns true if a transport for the given protocol is registered. */
  has(protocol: string): boolean {
    return this.transports.has(protocol);
  }
}
