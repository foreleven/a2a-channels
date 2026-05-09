/**
 * Unit tests for WsTunnelConnectionRegistry.
 *
 * Uses lightweight WebSocket stubs so no real network is needed.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { EventEmitter } from "node:events";

import { WsTunnelConnectionRegistry } from "./ws-tunnel-registry.js";

// ---------------------------------------------------------------------------
// Minimal WebSocket stub
// ---------------------------------------------------------------------------

type WsReadyState = 0 | 1 | 2 | 3; // CONNECTING | OPEN | CLOSING | CLOSED

class FakeWs extends EventEmitter {
  readyState: WsReadyState = 1; // OPEN
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  terminate(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  /** Simulate an inbound message from the relay CLI. */
  receiveMessage(data: string): void {
    this.emit("message", Buffer.from(data));
  }

  /** Simulate the remote end closing the connection. */
  closeRemotely(): void {
    this.readyState = 3;
    this.emit("close");
  }

  /** Simulate a WS error. */
  emitError(err: Error): void {
    this.readyState = 3;
    this.emit("error", err);
    this.emit("close");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WsTunnelConnectionRegistry", () => {
  test("isConnected returns false when no connection is registered", () => {
    const registry = new WsTunnelConnectionRegistry();
    assert.equal(registry.isConnected("agent-x"), false);
  });

  test("isConnected returns true after a connection is registered", () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();

    registry.register("agent-1", ws as never);

    assert.equal(registry.isConnected("agent-1"), true);
  });

  test("isConnected returns false after the connection is closed", () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();

    registry.register("agent-1", ws as never);
    ws.closeRemotely();

    assert.equal(registry.isConnected("agent-1"), false);
  });

  test("send sends a JSON-RPC frame to the relay and resolves with its response", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const requestId = "req-1";
    const frame = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "message/send",
      params: {},
    });

    // Call send() and inject the response message asynchronously (mimicking the
    // relay processing the frame and sending a response back).
    const responseFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { kind: "message", role: "agent", parts: [] },
    });

    const pending = registry.send("agent-1", frame, 2_000);
    // Yield to let the registry queue the request, then inject the response.
    await Promise.resolve();
    ws.receiveMessage(responseFrame);

    const response = await pending;
    const parsed = JSON.parse(response) as { id: string };
    assert.equal(parsed.id, requestId);
  });

  test("send rejects when the agent is not connected", async () => {
    const registry = new WsTunnelConnectionRegistry();

    await assert.rejects(
      () => registry.send("offline-agent", JSON.stringify({ id: "r1" }), 1_000),
      /not connected/i,
    );
  });

  test("send rejects when the relay returns a JSON-RPC error frame", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const requestId = "req-err";
    const frame = JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "message/send" });

    const errorFrame = JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      error: { code: -32_000, message: "executor failed" },
    });

    const pending = registry.send("agent-1", frame, 2_000);
    await Promise.resolve();
    ws.receiveMessage(errorFrame);

    await assert.rejects(() => pending, /executor failed/);
  });

  test("send rejects after the configured timeout", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const frame = JSON.stringify({ jsonrpc: "2.0", id: "slow-req", method: "message/send" });

    // Never send a response – the registry must time out.
    await assert.rejects(
      () => registry.send("agent-1", frame, 50), // 50 ms timeout
      /timed out/i,
    );
  });

  test("registering a second connection for the same agentId replaces the first", () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();

    registry.register("agent-1", ws1 as never);
    registry.register("agent-1", ws2 as never);

    // Old connection should have been terminated.
    assert.equal(ws1.readyState, 3 /* CLOSED */);
    // New connection is active.
    assert.equal(registry.isConnected("agent-1"), true);
  });

  test("pending requests on the old connection are rejected when replaced", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws1 = new FakeWs();
    registry.register("agent-1", ws1 as never);

    const frame = JSON.stringify({ jsonrpc: "2.0", id: "pending-req", method: "message/send" });
    const pending = assert.rejects(
      () => registry.send("agent-1", frame, 30_000),
      /Replaced/,
    );

    // Replace the connection while the request is still pending.
    const ws2 = new FakeWs();
    registry.register("agent-1", ws2 as never);

    await pending;
  });

  test("unregister rejects all pending requests and terminates the connection", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const frame = JSON.stringify({ jsonrpc: "2.0", id: "unregister-req", method: "message/send" });
    const pending = assert.rejects(
      () => registry.send("agent-1", frame, 30_000),
      /shutting down/i,
    );

    registry.unregister("agent-1");
    assert.equal(registry.isConnected("agent-1"), false);

    await pending;
  });

  test("stop() terminates all active connections", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws1 = new FakeWs();
    const ws2 = new FakeWs();

    registry.register("agent-a", ws1 as never);
    registry.register("agent-b", ws2 as never);

    await registry.stop();

    assert.equal(registry.isConnected("agent-a"), false);
    assert.equal(registry.isConnected("agent-b"), false);
    assert.equal(ws1.readyState, 3 /* CLOSED */);
    assert.equal(ws2.readyState, 3 /* CLOSED */);
  });

  test("ignores non-JSON messages from the relay", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const requestId = "req-noise";
    const frame = JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "message/send" });
    const realResponse = JSON.stringify({ jsonrpc: "2.0", id: requestId, result: {} });

    const pending = registry.send("agent-1", frame, 2_000);
    // Send garbage first, then the real response.
    await Promise.resolve();
    ws.receiveMessage("not-json");
    ws.receiveMessage('{ "malformed }');
    ws.receiveMessage(realResponse);

    const response = await pending;
    const parsed = JSON.parse(response) as { id: string };
    assert.equal(parsed.id, requestId);
  });

  test("connection error rejects pending requests", async () => {
    const registry = new WsTunnelConnectionRegistry();
    const ws = new FakeWs();
    registry.register("agent-1", ws as never);

    const frame = JSON.stringify({ jsonrpc: "2.0", id: "err-req", method: "message/send" });
    const pending = assert.rejects(
      () => registry.send("agent-1", frame, 30_000),
      /WS error/i,
    );

    ws.emitError(new Error("network failure"));
    await pending;
  });
});
