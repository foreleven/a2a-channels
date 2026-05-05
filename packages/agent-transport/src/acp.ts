/**
 * ACP (Agent Communication Protocol) transport adapter.
 *
 * Implements AgentTransport over the ACP stdio protocol using
 * @agentclientprotocol/sdk.
 * Reference: https://agentcommunicationprotocol.dev/
 */

import type {
  ACPAgentConfig,
  ACPStdioAgentConfig,
  AgentProtocolConfig,
  AgentRequest,
  AgentResponse,
  AgentTransport,
  AgentTransportFactory,
} from "./transport.js";
import { ACPStdioClient } from "./acp-stdio.js";

// ---------------------------------------------------------------------------
// ACPTransport
// ---------------------------------------------------------------------------

/** Agent transport adapter for ACP-compatible agents (stdio only). */
export class ACPTransport implements AgentTransportFactory {
  readonly protocol = "acp";

  create(config: AgentProtocolConfig): AgentTransport {
    if (!isACPAgentConfig(config)) {
      throw new Error("ACP transport requires config.transport");
    }

    return new ACPStdioTransport(config);
  }
}

function isACPAgentConfig(config: AgentProtocolConfig): config is ACPAgentConfig {
  return "transport" in config;
}

class ACPStdioTransport implements AgentTransport {
  readonly protocol = "acp";
  private readonly stdio = new ACPStdioClient();

  constructor(private readonly config: ACPStdioAgentConfig) {}

  send(request: AgentRequest): Promise<AgentResponse> {
    return this.stdio.send(request, this.config);
  }

  start(): Promise<void> {
    return this.stdio.start(this.config);
  }

  stop(): Promise<void> {
    return this.stdio.stop(this.config);
  }
}
