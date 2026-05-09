/**
 * `relay serve <agent-id>` command
 *
 * Fetches the runner configuration from the gateway and starts a persistent
 * WebSocket tunnel session.  Incoming A2A JSON-RPC frames are processed by
 * the Claude Code executor and responses are sent back over the tunnel.
 *
 * Credentials are resolved in priority order:
 *   1. CLI flags (`--gateway-url`, `--relay-token`)
 *   2. Environment variables (`RELAY_GATEWAY_URL`, `RELAY_TOKEN`)
 */

import { fetchRunnerConfig } from "../gateway-client.js";
import { ClaudeCodeExecutor } from "../executors/claude-code.js";
import { WsTunnelClient } from "../ws-tunnel.js";
import type { RelayCredentials } from "../types.js";

export interface ServeOptions {
  gatewayUrl?: string;
  relayToken?: string;
}

export async function runServe(
  agentId: string,
  opts: ServeOptions,
): Promise<void> {
  const creds = resolveCredentials(agentId, opts);

  console.log(`[relay] Fetching runner config from ${creds.gatewayUrl} …`);
  const config = await fetchRunnerConfig(creds);
  console.log(
    `[relay] Agent: ${config.name} (${config.agentId}) | executor: ${config.executor.type}`,
  );

  const executor = new ClaudeCodeExecutor(config.executor);

  const client = new WsTunnelClient({
    config,
    relayToken: creds.relayToken,
    executor,
    onConnected: () => {
      console.log(`[relay] Connected to gateway at ${config.gatewayWsUrl}`);
    },
    onDisconnected: () => {
      console.log("[relay] Disconnected from gateway, reconnecting …");
    },
    onError: (err) => {
      console.error(`[relay] WebSocket error: ${err.message}`);
    },
  });

  client.connect();
  console.log("[relay] Serving – press Ctrl+C to stop");

  // Keep the process alive until signalled
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      console.log("\n[relay] Shutting down …");
      client.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      client.stop();
      resolve();
    });
  });
}

function resolveCredentials(
  agentId: string,
  opts: ServeOptions,
): RelayCredentials {
  const gatewayUrl =
    opts.gatewayUrl ??
    process.env["RELAY_GATEWAY_URL"] ??
    "http://localhost:7890";

  const relayToken =
    opts.relayToken ?? process.env["RELAY_TOKEN"];

  if (!relayToken) {
    throw new Error(
      "Relay token is required.\n" +
        "  Provide it via --relay-token <token> or the RELAY_TOKEN environment variable.",
    );
  }

  return { gatewayUrl, agentId, relayToken };
}
