/**
 * WsTunnelConnectionRegistry
 *
 * Gateway-side registry of live WebSocket connections opened by relay CLI
 * instances.  Each relay agent (identified by agentId) maintains at most one
 * active connection at a time; a new connection for the same agentId replaces
 * the previous one.
 *
 * The registry also tracks pending A2A JSON-RPC requests so that
 * `WsTunnelTransportFactory`-created transports can await response frames
 * over the live WebSocket.
 *
 * This class implements the `WsTunnelConnectionSource` interface from
 * `@agent-relay/agent-transport` and is registered in the DI container.
 */

import { injectable } from "inversify";
import type { WebSocket } from "ws";
import type { WsTunnelConnectionSource } from "@agent-relay/agent-transport";

interface PendingRequest {
  resolve: (frame: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveConnection {
  ws: WebSocket;
  /** Map from JSON-RPC request id → pending response handlers. */
  pending: Map<string, PendingRequest>;
}

/** Maximum number of concurrently pending requests per agent connection. */
const MAX_PENDING = 100;

@injectable()
export class WsTunnelConnectionRegistry implements WsTunnelConnectionSource {
  private readonly connections = new Map<string, ActiveConnection>();

  // ------------------------------------------------------------------
  // WsTunnelConnectionSource interface
  // ------------------------------------------------------------------

  isConnected(agentId: string): boolean {
    const conn = this.connections.get(agentId);
    if (!conn) return false;
    // ws.OPEN === 1
    return conn.ws.readyState === 1;
  }

  async send(
    agentId: string,
    frame: string,
    timeoutMs: number,
  ): Promise<string> {
    const conn = this.connections.get(agentId);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error(
        `Relay agent "${agentId}" is not connected to the gateway`,
      );
    }

    if (conn.pending.size >= MAX_PENDING) {
      throw new Error(
        `Too many concurrent requests to relay agent "${agentId}"`,
      );
    }

    const requestId = (JSON.parse(frame) as { id?: string }).id ?? "";

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(requestId);
        reject(
          new Error(
            `Request "${requestId}" to relay agent "${agentId}" timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);

      conn.pending.set(requestId, { resolve, reject, timer });

      try {
        conn.ws.send(frame);
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ------------------------------------------------------------------
  // Connection lifecycle – called by WsTunnelRouteHandler
  // ------------------------------------------------------------------

  /** Register a newly authenticated WebSocket connection for agentId. */
  register(agentId: string, ws: WebSocket): void {
    // If there is an existing connection, reject its pending requests and close it.
    const existing = this.connections.get(agentId);
    if (existing) {
      this.rejectAllPending(existing, "Replaced by a new relay connection");
      existing.ws.terminate();
    }

    const conn: ActiveConnection = { ws, pending: new Map() };
    this.connections.set(agentId, conn);

    ws.on("message", (data: Buffer | string) => {
      this.handleIncoming(agentId, conn, String(data));
    });

    ws.on("close", () => {
      if (this.connections.get(agentId) === conn) {
        this.connections.delete(agentId);
      }
      this.rejectAllPending(conn, "Relay connection closed");
    });

    ws.on("error", (err: Error) => {
      if (this.connections.get(agentId) === conn) {
        this.connections.delete(agentId);
      }
      this.rejectAllPending(conn, `Relay WS error: ${err.message}`);
    });
  }

  /** Cleanly remove the connection for agentId (e.g. on gateway shutdown). */
  unregister(agentId: string): void {
    const conn = this.connections.get(agentId);
    if (!conn) return;
    this.connections.delete(agentId);
    this.rejectAllPending(conn, "Gateway shutting down");
    conn.ws.terminate();
  }

  // ServiceContribution interface – registered with ServiceContributionToken so
  // that GatewayServer participates in the registry's shutdown lifecycle.

  /** No-op: the registry is ready as soon as it is instantiated. */
  async start(): Promise<void> {}

  /** Shut down all connections (called during gateway shutdown). */
  async stop(): Promise<void> {
    for (const [agentId] of this.connections) {
      this.unregister(agentId);
    }
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  private handleIncoming(
    agentId: string,
    conn: ActiveConnection,
    raw: string,
  ): void {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return; // Discard non-JSON frames
    }

    if (
      typeof frame !== "object" ||
      frame === null ||
      !("id" in frame)
    ) {
      return;
    }

    const id = String((frame as Record<string, unknown>)["id"] ?? "");
    const pending = conn.pending.get(id);
    if (!pending) {
      return; // No outstanding request for this id; ignore
    }

    conn.pending.delete(id);
    clearTimeout(pending.timer);

    if ("error" in (frame as Record<string, unknown>)) {
      const err = (frame as Record<string, unknown>)["error"] as
        | Record<string, unknown>
        | undefined;
      pending.reject(
        new Error(
          `Relay agent "${agentId}" returned error: ${err?.["message"] ?? "unknown"}`,
        ),
      );
    } else {
      pending.resolve(raw);
    }
  }

  private rejectAllPending(conn: ActiveConnection, reason: string): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    conn.pending.clear();
  }
}
