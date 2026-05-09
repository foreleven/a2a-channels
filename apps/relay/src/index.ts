#!/usr/bin/env node
/**
 * relay – CLI for the agent-relay WebSocket tunnel protocol.
 *
 * Commands:
 *   relay serve <agent-id>            Connect the local Claude Code executor
 *                                     to the gateway and process messages.
 *   relay exec  <agent-id> <message>  Run a single message locally (no WS).
 *
 * Credentials (gateway URL, agent ID, relay token) are read from CLI flags
 * or environment variables (RELAY_GATEWAY_URL, RELAY_TOKEN).
 */

import { Command } from "commander";
import { runServe } from "./commands/serve.js";
import { runExec } from "./commands/exec.js";

const program = new Command();

program
  .name("relay")
  .description(
    "relay – connect a Claude Code executor to the agent-relay gateway",
  )
  .version("0.1.0");

// ---------------------------------------------------------------------------
// relay serve <agent-id>
// ---------------------------------------------------------------------------

program
  .command("serve <agent-id>")
  .description(
    "Connect a local Claude Code executor to the gateway via WebSocket tunnel",
  )
  .option(
    "--gateway-url <url>",
    "Gateway base URL (default: RELAY_GATEWAY_URL or http://localhost:7890)",
  )
  .option(
    "--relay-token <token>",
    "Relay authentication token (default: RELAY_TOKEN env var)",
  )
  .action(async (agentId: string, opts: { gatewayUrl?: string; relayToken?: string }) => {
    try {
      await runServe(agentId, opts);
    } catch (err) {
      console.error(
        `[relay] Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// relay exec <agent-id> <message>
// ---------------------------------------------------------------------------

program
  .command("exec <agent-id> <message>")
  .description(
    "Run a single message through the local executor without opening a WS tunnel",
  )
  .option(
    "--gateway-url <url>",
    "Gateway base URL (default: RELAY_GATEWAY_URL or http://localhost:7890)",
  )
  .option(
    "--relay-token <token>",
    "Relay authentication token (default: RELAY_TOKEN env var)",
  )
  .action(
    async (
      agentId: string,
      message: string,
      opts: { gatewayUrl?: string; relayToken?: string },
    ) => {
      try {
        await runExec(agentId, message, opts);
      } catch (err) {
        console.error(
          `[relay] Error: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
