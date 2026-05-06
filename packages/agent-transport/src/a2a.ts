/**
 * A2A (Agent-to-Agent) protocol transport adapter.
 *
 * Implements AgentTransport over the A2A JSON-RPC protocol using
 * @a2a-js/sdk.
 */

import crypto from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { MessageSendParams } from "@a2a-js/sdk";
import type {
  A2AAgentConfig,
  AgentProtocolConfig,
  AgentRequest,
  AgentResponse,
  AgentResponseStreamEvent,
  AgentTransport,
  AgentTransportFactory,
} from "./transport.js";

/** Extract the first text reply from an A2A result envelope. */
function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const rec = result as Record<string, unknown>;

  // Unwrap JSON-RPC success envelope
  if ("jsonrpc" in rec && "result" in rec) return extractText(rec["result"]);

  if (rec["kind"] === "message") {
    const parts = Array.isArray(rec["parts"]) ? rec["parts"] : [];
    return parts
      .filter(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          (p as Record<string, unknown>)["kind"] === "text",
      )
      .map(
        (p: unknown) =>
          ((p as Record<string, unknown>)["text"] as string) ?? "",
      )
      .join("\n")
      .trim();
  }

  if (rec["kind"] === "task") {
    const texts: string[] = [];
    for (const artifact of (Array.isArray(rec["artifacts"])
      ? rec["artifacts"]
      : []) as Array<Record<string, unknown>>) {
      for (const part of (Array.isArray(artifact["parts"])
        ? artifact["parts"]
        : []) as Array<Record<string, unknown>>) {
        if (part["kind"] === "text" && typeof part["text"] === "string") {
          texts.push(part["text"]);
        }
      }
    }
    return texts.join("\n").trim();
  }

  if (rec["kind"] === "artifact-update") {
    return extractText({
      kind: "task",
      artifacts: [rec["artifact"]],
    });
  }

  return "";
}

/** Factory for JSON-RPC A2A-compatible agent transports. */
export class A2ATransport implements AgentTransportFactory {
  readonly protocol = "a2a";

  create(config: AgentProtocolConfig): AgentTransport {
    if (!isA2AAgentConfig(config)) {
      throw new Error("A2A transport requires config.url");
    }

    return new A2AAgentTransport(config);
  }
}

function isA2AAgentConfig(config: AgentProtocolConfig): config is A2AAgentConfig {
  return "url" in config && typeof config.url === "string";
}

/** Agent transport adapter for one configured JSON-RPC A2A-compatible agent. */
class A2AAgentTransport implements AgentTransport {
  readonly protocol = "a2a";
  private readonly factory = new ClientFactory();
  /** Cache the resolved client to avoid re-fetching the agent card. */
  private readonly clientCache = new Map<
    string,
    Awaited<ReturnType<ClientFactory["createFromUrl"]>>
  >();

  constructor(private readonly config: A2AAgentConfig) {}

  async send(request: AgentRequest): Promise<AgentResponse> {
    const timeoutMs = 30_000;
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`A2A request timed out after ${timeoutMs}ms`);
        abortController.abort(err);
        reject(err);
      }, timeoutMs);
    });

    const requestPromise = (async () => {
      // createFromUrl is included in the timeout race via Promise.race below,
      // so a hang in client discovery will be cancelled by the timeout winning.
      const agentUrl = this.config.url;
      let client = this.clientCache.get(agentUrl);
      if (!client) {
        client = await this.factory.createFromUrl(agentUrl);
        this.clientCache.set(agentUrl, client);
      }
      const result = await client.sendMessage(this.buildPayload(request), {
        signal: abortController.signal,
      });
      const text = extractText(result);
      return { text: text || "(no response from agent)" };
    })();

    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async *stream(request: AgentRequest): AsyncIterable<AgentResponseStreamEvent> {
    const timeoutMs = 120_000;
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let finalText = "";
    let yielded = false;
    let yieldedFinal = false;

    try {
      timeoutHandle = setTimeout(() => {
        abortController.abort(
          new Error(`A2A stream timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      const agentUrl = this.config.url;
      let client = this.clientCache.get(agentUrl);
      if (!client) {
        client = await this.factory.createFromUrl(agentUrl);
        this.clientCache.set(agentUrl, client);
      }

      const stream = client.sendMessageStream(this.buildPayload(request), {
        signal: abortController.signal,
      });

      for await (const event of stream) {
        const text = extractText(event);
        if (!text) {
          continue;
        }

        if (event.kind === "artifact-update") {
          yielded = true;
          finalText = event.append ? `${finalText}${text}` : text;
          yield {
            kind: event.lastChunk ? "final" : "block",
            text: event.lastChunk ? finalText : text,
          };
          if (event.lastChunk) {
            yieldedFinal = true;
          }
          continue;
        }

        finalText = text;
        yielded = true;
        if (event.kind === "message") {
          yieldedFinal = true;
          yield { kind: "final", text };
        } else {
          yield { kind: "partial", text };
        }
      }

      if (!yielded) {
        const response = await this.send(request);
        yield { kind: "final", text: response.text };
        return;
      }

      if (finalText && !yieldedFinal) {
        yield { kind: "final", text: finalText };
      }
    } catch (error) {
      if (yielded && finalText && !yieldedFinal) {
        yield { kind: "final", text: finalText };
        return;
      }

      throw error;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildPayload(request: AgentRequest): MessageSendParams {
    const contextId = request.sessionKey;
    return {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ kind: "text", text: request.userMessage }],
        ...(contextId ? { contextId } : {}),
        metadata: { userId: request.accountId },
      },
    };
  }
}
