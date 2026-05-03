/**
 * Typed API client for the A2A Channels Gateway REST API.
 *
 * In development, Next.js rewrites `/api/*` to the gateway (see next.config.ts),
 * so requests use a relative base path by default.
 * Set NEXT_PUBLIC_GATEWAY_URL to an absolute URL in production deployments.
 */

const BASE = process.env["NEXT_PUBLIC_GATEWAY_URL"] ?? "";

// ---------------------------------------------------------------------------
// Shared DTOs returned by the gateway API.
// ---------------------------------------------------------------------------

export interface ChannelBinding {
  id: string;
  name: string;
  channelType: string;
  accountId: string;
  channelConfig: Record<string, unknown>;
  agentId: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  url: string;
  description?: string;
  createdAt: string;
}

export type RuntimeChannelOwnership =
  | "local"
  | "cluster-lease"
  | "unassigned"
  | "disabled";

export interface RuntimeChannelStatus {
  bindingId: string;
  mode: "local" | "cluster";
  ownership: RuntimeChannelOwnership;
  status:
    | "idle"
    | "connecting"
    | "connected"
    | "disconnected"
    | "error"
    | "unknown";
  ownerNodeId?: string;
  ownerDisplayName?: string;
  agentUrl?: string;
  error?: string;
  updatedAt?: string;
  leaseHeld: boolean;
}

// ---------------------------------------------------------------------------
// Channel bindings
// ---------------------------------------------------------------------------

export async function listChannels(): Promise<ChannelBinding[]> {
  const res = await fetch(`${BASE}/api/channels`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding[]>;
}

export async function createChannel(
  data: Omit<ChannelBinding, "id" | "createdAt">,
): Promise<ChannelBinding> {
  const res = await fetch(`${BASE}/api/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding>;
}

export async function updateChannel(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
): Promise<ChannelBinding> {
  const res = await fetch(`${BASE}/api/channels/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelBinding>;
}

export async function deleteChannel(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/channels/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

export async function listAgents(): Promise<AgentConfig[]> {
  const res = await fetch(`${BASE}/api/agents`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig[]>;
}

export async function createAgent(
  data: Omit<AgentConfig, "id" | "createdAt">,
): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig>;
}

export async function updateAgent(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/api/agents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<AgentConfig>;
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api/agents/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export async function listRuntimeChannelStatuses(): Promise<
  RuntimeChannelStatus[]
> {
  const res = await fetch(`${BASE}/api/runtime/connections`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<RuntimeChannelStatus[]>;
}
