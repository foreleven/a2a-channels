import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";

import { createDevOrchestrator } from "./dev.mjs";

class FakeChildProcess extends EventEmitter {
  killed = false;

  kill() {
    this.killed = true;
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

describe("dev orchestrator", () => {
  test("starts web only after gateway is reachable", async () => {
    const started = [];
    const children = [];
    const requestedUrls = [];
    let fetchAttempts = 0;

    const orchestrator = createDevOrchestrator({
      spawnProcess: (command, args) => {
        const child = new FakeChildProcess();
        children.push(child);
        started.push([command, ...args].join(" "));
        return child;
      },
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        fetchAttempts += 1;
        if (fetchAttempts < 3) {
          throw new Error("not ready");
        }
        return { ok: true };
      },
      sleep: async () => {},
      logger: { info: () => {}, error: () => {} },
      gatewayWait: { maxAttempts: 5, intervalMs: 1 },
    });

    await orchestrator.startAll();

    assert.deepEqual(started, [
      "make gateway",
      "pnpm run echo-agent",
      "pnpm run web",
    ]);
    assert.deepEqual(requestedUrls, [
      "http://localhost:7890/api/health",
      "http://localhost:7890/api/health",
      "http://localhost:7890/api/health",
    ]);
    assert.equal(fetchAttempts, 3);
    assert.equal(children.some((child) => child.killed), false);
  });

  test("cleans up gateway when readiness never succeeds", async () => {
    const children = [];
    const orchestrator = createDevOrchestrator({
      spawnProcess: () => {
        const child = new FakeChildProcess();
        children.push(child);
        return child;
      },
      fetchImpl: async () => {
        throw new Error("not ready");
      },
      sleep: async () => {},
      logger: { info: () => {}, error: () => {} },
      gatewayWait: { maxAttempts: 2, intervalMs: 1 },
    });

    await assert.rejects(
      () => orchestrator.startAll(),
      /Gateway did not become ready/,
    );
    assert.equal(children.length, 1);
    assert.equal(children[0].killed, true);
  });
});
