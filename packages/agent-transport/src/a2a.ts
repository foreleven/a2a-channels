/**
 * A2A (Agent-to-Agent) protocol transport adapter.
 *
 * Implements AgentTransport over the A2A JSON-RPC protocol using
 * @a2a-js/sdk.  The transport is stateless; a single instance can be
 * shared across all channel accounts.
 */

import crypto from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { MessageSendParams } from "@a2a-js/sdk";
import type {
  AgentRequest,
  AgentResponse,
  AgentTransport,
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

  return "";
}

/** Agent transport adapter for JSON-RPC A2A-compatible agents. */
export class A2ATransport implements AgentTransport {
  readonly protocol = "a2a";
  private readonly factory = new ClientFactory();
  /** Cache resolved clients by agent URL to avoid re-fetching the agent card. */
  private readonly clientCache = new Map<
    string,
    Awaited<ReturnType<ClientFactory["createFromUrl"]>>
  >();

  async send(agentUrl: string, request: AgentRequest): Promise<AgentResponse> {
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
      let client = this.clientCache.get(agentUrl);
      if (!client) {
        client = await this.factory.createFromUrl(agentUrl);
        this.clientCache.set(agentUrl, client);
      }
      const payload: MessageSendParams = {
        message: {
          kind: "message",
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ kind: "text", text: request.userMessage }],
          ...(request.contextId ? { contextId: request.contextId } : {}),
        },
      };
      const result = await client.sendMessage(payload);
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
}
