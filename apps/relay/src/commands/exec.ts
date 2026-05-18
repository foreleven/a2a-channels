/**
 * `relay exec <agent-id> "<message>"` command
 *
 * Fetches the runner configuration from the gateway, creates the executor,
 * and runs a single message without opening a WebSocket tunnel.  Useful for
 * quick local tests.
 *
 * Output is written to stdout; errors to stderr.
 */

import { fetchRunnerConfig } from "../gateway-client.js";
import { createRelayExecutor } from "../executors/relay-executor.js";
import type { RelayCredentials } from "../types.js";

export interface ExecOptions {
  gatewayUrl?: string;
  relayToken?: string;
}

export async function runExec(
  agentId: string,
  message: string,
  opts: ExecOptions,
): Promise<void> {
  const creds = resolveCredentials(agentId, opts);

  const config = await fetchRunnerConfig(creds);
  const executor = createRelayExecutor(config);

  try {
    const result = await executor.execute(message);
    process.stdout.write(result);
    if (!result.endsWith("\n")) {
      process.stdout.write("\n");
    }
  } finally {
    await executor.stop();
  }
}

function resolveCredentials(
  agentId: string,
  opts: ExecOptions,
): RelayCredentials {
  const gatewayUrl =
    opts.gatewayUrl ??
    process.env["RELAY_GATEWAY_URL"] ??
    "http://localhost:7890";

  const relayToken = opts.relayToken ?? process.env["RELAY_TOKEN"];

  if (!relayToken) {
    throw new Error(
      "Relay token is required.\n" +
        "  Provide it via --relay-token <token> or the RELAY_TOKEN environment variable.",
    );
  }

  return { gatewayUrl, agentId, relayToken };
}
