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

export interface AgentTransport {
  /** Short protocol identifier, e.g. "a2a" or "acp". */
  readonly protocol: string;
  send(agentUrl: string, request: AgentRequest): Promise<AgentResponse>;
}
