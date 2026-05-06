/**
 * ACP (Agent Communication Protocol) transport adapter.
 *
 * Implements AgentTransport over the ACP stdio protocol using
 * @agentclientprotocol/sdk.
 * Reference: https://agentcommunicationprotocol.dev/
 */

import type {
  ACPAgentConfig,
  AgentTransportContext,
  AgentProtocolConfig,
  AgentTransport,
  AgentTransportFactory,
} from "./transport.js";
import { ACPStdioTransport } from "./acp-stdio.js";

// ---------------------------------------------------------------------------
// ACPTransport
// ---------------------------------------------------------------------------

/** Agent transport adapter for ACP-compatible agents (stdio only). */
export class ACPTransport implements AgentTransportFactory {
  readonly protocol = "acp";

  create(
    config: AgentProtocolConfig,
    context?: AgentTransportContext,
  ): AgentTransport {
    if (!isACPAgentConfig(config)) {
      throw new Error("ACP transport requires config.transport");
    }

    return new ACPStdioTransport(config, context);
  }
}

function isACPAgentConfig(config: AgentProtocolConfig): config is ACPAgentConfig {
  return "transport" in config;
}
