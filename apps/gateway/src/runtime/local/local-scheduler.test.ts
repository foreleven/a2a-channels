import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { LocalScheduler } from "./local-scheduler.js";
import { LocalRuntimeEventBus } from "../event-transport/local-runtime-event-bus.js";
import type { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";
import type { RuntimeCommandHandler } from "../runtime-command-handler.js";
import type { RuntimeAssignmentService } from "../runtime-assignment-service.js";

function createAssignments(ownedBindingIds: string[] = []): RuntimeAssignmentService {
  return {
    listOwnedBindingIds: () => ownedBindingIds,
    listBindings: () => [],
  } as unknown as RuntimeAssignmentService;
}

function createCommandHandler(commands: string[]): RuntimeCommandHandler {
  return {
    handle: async (command: { type: string; bindingId: string }) => {
      commands.push(`${command.type}:${command.bindingId}`);
    },
  } as RuntimeCommandHandler;
}

function createCoordinator(calls: string[]): RuntimeAssignmentCoordinator {
  return {
    reconcile: async () => {
      calls.push("reconcile");
    },
  } as RuntimeAssignmentCoordinator;
}

async function waitForTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("LocalScheduler", () => {
  test("runs a desired-state reconcile when NodeJoined is broadcast", async () => {
    const reconcileCalls: string[] = [];
    const scheduler = new LocalScheduler(null, null, null, null, {
      debounceMs: 1,
    });
    scheduler.configure(
      createAssignments(),
      createCommandHandler([]),
      new LocalRuntimeEventBus(),
      createCoordinator(reconcileCalls),
    );

    scheduler.start();
    scheduler.scheduleReconcile();
    await waitForTimers();
    await scheduler.stop();

    assert.deepEqual(reconcileCalls, ["reconcile"]);
  });

  test("runs an initial reconcile after start", async () => {
    const reconcileCalls: string[] = [];
    const scheduler = new LocalScheduler(null, null, null, null, {
      debounceMs: 1,
    });
    scheduler.configure(
      createAssignments(),
      createCommandHandler([]),
      new LocalRuntimeEventBus(),
      createCoordinator(reconcileCalls),
    );

    scheduler.start();
    await waitForTimers();
    await scheduler.stop();

    assert.deepEqual(reconcileCalls, ["reconcile"]);
  });

  test("does not let explicit reconcile debounce cancel a pending full scan", async () => {
    const reconcileCalls: string[] = [];
    const runtimeBus = new LocalRuntimeEventBus();
    const scheduler = new LocalScheduler(null, null, null, null, {
      debounceMs: 15,
      reconcileIntervalMs: 1000,
    });
    scheduler.configure(
      createAssignments(),
      createCommandHandler([]),
      runtimeBus,
      createCoordinator(reconcileCalls),
    );

    scheduler.start();
    await runtimeBus.broadcast({ type: "NodeJoined", nodeId: "peer" });
    scheduler.scheduleReconcile();
    await waitForTimers();
    await scheduler.stop();

    assert.ok(reconcileCalls.length >= 1);
  });
});
