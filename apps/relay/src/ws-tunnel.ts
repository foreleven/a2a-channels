/**
 * WS tunnel client for the relay CLI.
 *
 * Connects to the gateway's WebSocket endpoint (`/ws/a2a/:agentId`) and
 * listens for incoming A2A JSON-RPC `message/send` frames.  Each frame is
 * dispatched to the local executor, and the result is sent back as a
 * JSON-RPC response frame over the same WebSocket.
 *
 * The client automatically attempts to reconnect on disconnect with
 * exponential back-off.
 */

import WebSocket from "ws";
import type { RunnerConfig } from "./types.js";
import type { ClaudeCodeExecutor } from "./executors/claude-code.js";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const RECONNECT_MULTIPLIER = 2;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string | number;
  error: { code: number; message: string };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Extract text from an inbound `message/send` params.message object. */
function extractMessageText(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const p = params as Record<string, unknown>;
  const msg = p["message"];
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;
  const parts = Array.isArray(m["parts"]) ? m["parts"] : [];
  return parts
    .filter(
      (part: unknown) =>
        typeof part === "object" &&
        part !== null &&
        (part as Record<string, unknown>)["kind"] === "text",
    )
    .map(
      (part: unknown) =>
        ((part as Record<string, unknown>)["text"] as string) ?? "",
    )
    .join("\n")
    .trim();
}

/** Build an A2A-compatible JSON-RPC success response. */
function buildSuccessResponse(
  id: string | number,
  text: string,
): JsonRpcSuccessResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      kind: "message",
      role: "agent",
      parts: [{ kind: "text", text }],
    },
  };
}

/** Build a JSON-RPC error response. */
function buildErrorResponse(
  id: string | number,
  message: string,
): JsonRpcErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32_000, message },
  };
}

export interface WsTunnelClientOptions {
  config: RunnerConfig;
  relayToken: string;
  executor: ClaudeCodeExecutor;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (err: Error) => void;
}

/**
 * Manages the WebSocket tunnel connection from the relay CLI to the gateway.
 */
export class WsTunnelClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private stopped = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: WsTunnelClientOptions) {}

  /** Connect to the gateway and start processing messages. */
  connect(): void {
    this.stopped = false;
    this.doConnect();
  }

  /** Stop reconnecting and close the current connection. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private doConnect(): void {
    const { config, relayToken } = this.opts;
    const ws = new WebSocket(config.gatewayWsUrl, {
      headers: { Authorization: `Bearer ${relayToken}` },
    });

    this.ws = ws;

    ws.on("open", () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.opts.onConnected?.();
    });

    ws.on("message", (data: Buffer | string) => {
      void this.handleMessage(String(data));
    });

    ws.on("close", () => {
      this.ws = null;
      this.opts.onDisconnected?.();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
      // The 'close' event will fire after 'error' – reconnect logic lives there.
    });
  }

  private scheduleReconnect(): void {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(
      delay * RECONNECT_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) {
        this.doConnect();
      }
    }, delay);
  }

  private async handleMessage(raw: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return; // Ignore non-JSON frames
    }

    if (request.method !== "message/send" || request.id === undefined) {
      return;
    }

    const text = extractMessageText(request.params);
    let response: JsonRpcResponse;

    try {
      const result = await this.opts.executor.execute(text || "(empty message)");
      response = buildSuccessResponse(request.id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      response = buildErrorResponse(request.id, message);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(response));
    }
  }
}
