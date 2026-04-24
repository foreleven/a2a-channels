/**
 * ACP (Agent Communication Protocol) transport adapter.
 *
 * Implements AgentTransport over the BeeAI ACP REST protocol.
 * Reference: https://agentcommunicationprotocol.dev/
 *
 * The transport:
 *   1. POST {agentUrl}/runs  – create a run synchronously
 *   2. If the run is still in-progress (status "created" | "running"),
 *      poll GET {agentUrl}/runs/{run_id} until it reaches a terminal state.
 *   3. Extract the first text part from the agent's output.
 *
 * The transport is stateless; a single instance can be shared across all
 * channel accounts.
 */

import type {
  AgentRequest,
  AgentResponse,
  AgentTransport,
} from "./transport.js";

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

export class ACPTransport implements AgentTransport {
  readonly protocol = "acp";

  async send(agentUrl: string, request: AgentRequest): Promise<AgentResponse> {
    // Normalise base URL: strip trailing slashes (avoid regex to prevent ReDoS)
    let base = agentUrl;
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
      ...(request.contextId ? { session_id: request.contextId } : {}),
    };

    let run: AcpRunResponse;
    try {
      const res = await fetch(runsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
