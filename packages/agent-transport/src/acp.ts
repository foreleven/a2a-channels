/**
 * ACP (Agent Communication Protocol) transport adapter.
 *
 * Implements AgentTransport over the BeeAI ACP REST protocol.
 * Reference: https://agentcommunicationprotocol.dev/
 *
 * The transport:
 *   1. POST {config.url}/runs  – create a run synchronously
 *   2. If the run is still in-progress (status "created" | "running"),
 *      poll GET {config.url}/runs/{run_id} until it reaches a terminal state.
 *   3. Extract the first text part from the agent's output.
 *
 * The transport is stateless; a single instance can be shared across all
 * channel accounts.
 */

import type {
  ACPAgentConfig,
  ACPRestAgentConfig,
  ACPStdioAgentConfig,
  AgentProtocolConfig,
  AgentRequest,
  AgentResponse,
  AgentTransport,
  AgentTransportFactory,
} from "./transport.js";
import { ACPStdioClient } from "./acp-stdio.js";

// ---------------------------------------------------------------------------
// ACP wire types (minimal subset we actually use)
// ---------------------------------------------------------------------------

interface AcpContentPart {
  type: string;
  text?: string;
}

interface AcpMessage {
  role: string;
  content: AcpContentPart[];
}

interface AcpRunResponse {
  run_id?: string;
  runId?: string;       // some implementations use camelCase
  status: "created" | "running" | "completed" | "failed" | "cancelled" | string;
  output?: AcpMessage[];
  error?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise the run ID across camelCase and snake_case shapes. */
function getRunId(run: AcpRunResponse): string | undefined {
  return run.run_id ?? run.runId;
}

/** Extract the first text content from ACP output messages. */
function extractText(output: AcpMessage[] | undefined): string {
  if (!Array.isArray(output)) return "";
  for (const msg of output) {
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text.trim();
      }
    }
  }
  return "";
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POLL_INTERVAL_MS = 500;
/** Maximum number of poll attempts (each ~500 ms apart, not counting network latency). */
const MAX_POLLS = 60;

// ---------------------------------------------------------------------------
// ACPTransport
// ---------------------------------------------------------------------------

/** Agent transport adapter for ACP-compatible agents. */
export class ACPTransport implements AgentTransportFactory {
  readonly protocol = "acp";

  create(config: AgentProtocolConfig): AgentTransport {
    if (!isACPAgentConfig(config)) {
      throw new Error("ACP transport requires config.transport");
    }

    if (config.transport === "stdio") {
      return new ACPStdioTransport(config);
    }

    return new ACPRestTransport(config);
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

class ACPRestTransport implements AgentTransport {
  readonly protocol = "acp";

  constructor(private readonly config: ACPRestAgentConfig) {}

  async send(request: AgentRequest): Promise<AgentResponse> {
    // Normalise base URL: strip trailing slashes (avoid regex to prevent ReDoS)
    let base = this.config.url;
    while (base.endsWith("/")) base = base.slice(0, -1);
    const runsUrl = `${base}/runs`;

    const body = {
      input: [
        {
          role: "user",
          content: [{ type: "text", text: request.userMessage }],
        },
      ],
      // Pass context / session information when available
      ...(request.sessionKey ? { session_id: request.sessionKey } : {}),
    };

    let run: AcpRunResponse;
    try {
      const res = await fetch(runsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      run = (await res.json()) as AcpRunResponse;
    } catch (error) {
      console.error("[acp] failed to create run at", runsUrl, ":", String(error));
      return { text: `(agent unavailable: ${String(error)})` };
    }

    // If already completed, return immediately
    if (TERMINAL_STATUSES.has(run.status)) {
      return this.buildResponse(run);
    }

    // Otherwise poll until terminal
    const runId = getRunId(run);
    if (!runId) {
      console.error("[acp] run response missing run_id; cannot poll", run);
      return { text: "(agent error: missing run_id in response)" };
    }

    return this.pollUntilDone(base, runId);
  }

  private async pollUntilDone(base: string, runId: string): Promise<AgentResponse> {
    const runUrl = `${base}/runs/${runId}`;

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(POLL_INTERVAL_MS);

      let run: AcpRunResponse;
      try {
        const res = await fetch(runUrl);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}: ${text}`);
        }
        run = (await res.json()) as AcpRunResponse;
      } catch (error) {
        console.error("[acp] failed to poll run", runUrl, ":", String(error));
        return { text: `(agent polling error: ${String(error)})` };
      }

      if (TERMINAL_STATUSES.has(run.status)) {
        return this.buildResponse(run);
      }
    }

    return { text: "(agent timeout: run did not complete in time)" };
  }

  private buildResponse(run: AcpRunResponse): AgentResponse {
    if (run.status === "failed" || run.status === "cancelled") {
      console.error("[acp] run ended with status", run.status, run.error ?? "");
      return { text: `(agent run ${run.status})` };
    }
    const text = extractText(run.output);
    return { text: text || "(no response from agent)" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
