/**
 * Gateway API client for the relay CLI.
 *
 * Only the relay-token–authenticated endpoints are used here; the CLI does
 * not need admin JWT access.
 */

import type { RunnerConfig, RelayCredentials } from "./types.js";

/**
 * Fetches the runner configuration from the gateway API.
 *
 * The gateway authenticates this request via the relay token (Bearer).
 */
export async function fetchRunnerConfig(
  creds: RelayCredentials,
): Promise<RunnerConfig> {
  const url =
    creds.gatewayUrl.replace(/\/$/, "") +
    `/api/agents/${creds.agentId}/runner-config`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.relayToken}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(empty body)");
    throw new Error(
      `Failed to fetch runner config from gateway (${res.status}): ${body}`,
    );
  }

  return res.json() as Promise<RunnerConfig>;
}
