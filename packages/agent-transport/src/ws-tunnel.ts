/**
 * WebSocket tunnel transport for the `ws-tunnel` agent protocol.
 *
 * Instead of calling the relay agent over HTTP, the gateway waits for the
 * relay CLI to open a persistent WebSocket to `GET /ws/a2a/{agentId}`.
 * Inbound channel messages are delivered as standard A2A JSON-RPC
 * `message/send` frames over that connection; the relay CLI executes them
 * locally and sends back A2A JSON-RPC response frames.
 *
 * The actual WS connection management lives in the gateway-side
 * `WsTunnelConnectionRegistry` (which implements `WsTunnelConnectionSource`).
 * This module owns only the `AgentTransportFactory` adapter and the shared
 * DI token for the connection source.
 */

import crypto from "node:crypto";
import type { Part } from "@a2a-js/sdk";
import {
  type AgentCallContext,
  type AgentFile,
  type AgentProtocolConfig,
  type AgentRequest,
  type AgentResponse,
  type AgentTransport,
  type AgentTransportContext,
  type AgentTransportFactory,
  type WsTunnelAgentConfig,
  AgentRequestSession,
} from "./transport.js";

// ---------------------------------------------------------------------------
// WsTunnelConnectionSource interface
// ---------------------------------------------------------------------------

/**
 * Gateway-owned registry of live WS connections from relay CLI instances.
 * The canonical implementation (`WsTunnelConnectionRegistry`) lives in the
 * gateway runtime layer so that the agent-transport package stays free of the
 * `ws` npm dependency.
 */
export interface WsTunnelConnectionSource {
  /**
   * Send a serialised A2A JSON-RPC request frame to the relay agent identified
   * by `agentId` and resolve with the raw JSON-RPC response frame string.
   * Rejects with an error if the agent is offline or the request times out.
   */
  send(agentId: string, frame: string, timeoutMs: number): Promise<string>;

  /** Returns true when a live WS connection exists for the given agentId. */
  isConnected(agentId: string): boolean;
}

/** Inversify DI token for the WsTunnelConnectionSource binding. */
export const WsTunnelConnectionSource = Symbol.for(
  "@agent-relay/WsTunnelConnectionSource",
);

// ---------------------------------------------------------------------------
// AgentTransportFactory implementation
// ---------------------------------------------------------------------------

/**
 * Factory registered in the gateway DI container for the `"ws-tunnel"`
 * protocol.  Each call to `create()` produces a transport instance bound to
 * the given agentId so that `send()` can look up the correct WS connection.
 */
export class WsTunnelTransportFactory implements AgentTransportFactory {
  readonly protocol = "ws-tunnel" as const;

  constructor(private readonly source: WsTunnelConnectionSource) {}

  create(
    config: AgentProtocolConfig,
    context?: AgentTransportContext,
  ): AgentTransport {
    if (!isWsTunnelConfig(config)) {
      throw new Error(
        "WsTunnelTransportFactory requires a ws-tunnel agent config " +
          "(transport: 'ws-tunnel')",
      );
    }
    const agentId = context?.agentId ?? "";
    return new WsTunnelAgentTransport(agentId, config, this.source);
  }
}

function isWsTunnelConfig(
  config: AgentProtocolConfig,
): config is WsTunnelAgentConfig {
  return (
    typeof config === "object" &&
    config !== null &&
    "transport" in config &&
    (config as { transport?: unknown }).transport === "ws-tunnel"
  );
}

// ---------------------------------------------------------------------------
// Transport (per-agent instance)
// ---------------------------------------------------------------------------

class WsTunnelAgentTransport implements AgentTransport {
  readonly protocol = "ws-tunnel" as const;

  constructor(
    private readonly agentId: string,
    private readonly config: WsTunnelAgentConfig,
    private readonly source: WsTunnelConnectionSource,
  ) {}

  async send(
    request: AgentRequest,
    _ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    const timeoutMs = this.config.timeoutMs ?? 60_000;

    if (!this.source.isConnected(this.agentId)) {
      throw new Error(
        `Relay agent "${this.agentId}" is offline. ` +
          `Start the relay CLI with: relay serve ${this.agentId}`,
      );
    }

    const requestId = crypto.randomUUID();
    const contextId = AgentRequestSession.sessionId(request);
    const frame = buildJsonRpcRequest(requestId, request, contextId);

    const responseFrame = await this.source.send(
      this.agentId,
      JSON.stringify(frame),
      timeoutMs,
    );

    const parsed = JSON.parse(responseFrame) as unknown;
    const text = extractText(parsed);

    return { text: text || "(no response from relay agent)" };
  }
}

// ---------------------------------------------------------------------------
// A2A JSON-RPC frame helpers (minimal subset)
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: "message/send";
  params: {
    message: {
      kind: "message";
      messageId: string;
      role: "user";
      parts: Part[];
      contextId?: string;
      metadata?: Record<string, unknown>;
    };
  };
}

function buildJsonRpcRequest(
  id: string,
  request: AgentRequest,
  contextId: string | undefined,
): JsonRpcRequest {
  const parts: Part[] = [];
  if (request.message.trim()) {
    parts.push({ kind: "text", text: request.message });
  }
  parts.push(...buildFileParts(request.files ?? []));

  return {
    jsonrpc: "2.0",
    id,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts,
        ...(contextId ? { contextId } : {}),
        metadata: { userId: request.accountId },
      },
    },
  };
}

function buildFileParts(files: AgentFile[]): Part[] {
  const parts: Part[] = [];
  for (const f of files) {
    if (f.url) {
      parts.push({
        kind: "file",
        file: {
          uri: f.url,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.name ? { name: f.name } : {}),
        },
      });
    } else if (f.data) {
      parts.push({
        kind: "file",
        file: {
          bytes: f.data,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.name ? { name: f.name } : {}),
        },
      });
    }
  }
  return parts;
}

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
      .map((p: unknown) => ((p as Record<string, unknown>)["text"] as string) ?? "")
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
