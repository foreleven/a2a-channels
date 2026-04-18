import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeTasks = PluginRuntime["tasks"];

type BoundTaskRunsRuntime = ReturnType<
  PluginRuntimeTasks["runs"]["bindSession"]
>;
type BoundTaskFlowsRuntime = ReturnType<
  PluginRuntimeTasks["flows"]["bindSession"]
>;
type BoundTaskFlowRuntime = ReturnType<
  PluginRuntimeTasks["flow"]["bindSession"]
>;

function makeBoundTaskRuns(sessionKey: string): BoundTaskRunsRuntime {
  return {
    sessionKey,
    get: () => undefined,
    list: () => [],
    findLatest: () => undefined,
    resolve: () => undefined,
    cancel: async () =>
      ({ cancelled: false, found: false }) as Awaited<
        ReturnType<BoundTaskRunsRuntime["cancel"]>
      >,
  };
}

function makeBoundTaskFlows(sessionKey: string): BoundTaskFlowsRuntime {
  return {
    sessionKey,
    get: () => undefined,
    list: () => [],
    findLatest: () => undefined,
    resolve: () => undefined,
    getTaskSummary: () => undefined,
  };
}

function makeBoundTaskFlow(sessionKey: string): BoundTaskFlowRuntime {
  return {
    sessionKey,
    createManaged: () =>
      ({
        id: "",
        flowId: "",
        ownerKey: "",
        revision: 0,
        controllerId: "",
        goal: "",
        status: "queued" as const,
        syncMode: "managed" as const,
        notifyPolicy: "done_only" as const,
        createdAt: 0,
        updatedAt: 0,
      }) as ReturnType<BoundTaskFlowRuntime["createManaged"]>,
    get: () => undefined,
    list: () => [],
    findLatest: () => undefined,
    resolve: () => undefined,
    getTaskSummary: () => undefined,
    setWaiting: () => ({ applied: false, code: "not_found" as const }),
    resume: () => ({ applied: false, code: "not_found" as const }),
    finish: () => ({ applied: false, code: "not_found" as const }),
    fail: () => ({ applied: false, code: "not_found" as const }),
    requestCancel: () => ({ applied: false, code: "not_found" as const }),
    cancel: async () => ({ found: false, cancelled: false }),
    runTask: () => ({ created: false, reason: "stub", found: false }),
  };
}

/**
 * Build the `tasks` surface of a `PluginRuntime`.
 * All methods are stubs — the gateway does not manage task flows.
 */
export function buildTasksCompat(): PluginRuntimeTasks {
  return {
    runs: {
      bindSession: ({ sessionKey }) => makeBoundTaskRuns(sessionKey),
      fromToolContext: (ctx) => makeBoundTaskRuns(ctx.sessionKey ?? ""),
    },
    flows: {
      bindSession: ({ sessionKey }) => makeBoundTaskFlows(sessionKey),
      fromToolContext: (ctx) => makeBoundTaskFlows(ctx.sessionKey ?? ""),
    },
    flow: {
      bindSession: ({ sessionKey }) => makeBoundTaskFlow(sessionKey),
      fromToolContext: (ctx) => makeBoundTaskFlow(ctx.sessionKey ?? ""),
    },
  };
}
