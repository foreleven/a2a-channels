import type { AgentClientHandle, AgentConfig, AgentTransport } from "@a2a-channels/core";

export function createAgentClientHandle(
  agent: AgentConfig,
  transport: AgentTransport,
): AgentClientHandle {
  return {
    agentUrl: agent.url,
    protocol: agent.protocol ?? transport.protocol,
    send: (request) => transport.send(agent.url, request),
  };
}

export async function startAgentClients(
  clients: Iterable<AgentClientHandle>,
): Promise<void> {
  await Promise.all(Array.from(clients, (client) => client.start?.()));
}

export async function stopAgentClients(
  clients: Iterable<AgentClientHandle>,
): Promise<void> {
  await Promise.all(Array.from(clients, (client) => client.stop?.()));
}
