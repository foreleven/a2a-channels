import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeSystem = PluginRuntime["system"];

/**
 * Build the `system` surface of a `PluginRuntime`.
 *
 * Heartbeat and command execution are not applicable in the gateway context,
 * so all methods are stubs that log or return safe sentinel values.
 */
export function buildSystemCompat(): PluginRuntimeSystem {
  return {
    enqueueSystemEvent: (msg: string, meta?: unknown) => {
      console.log("[system]", msg, meta ?? "");
      return false;
    },
    requestHeartbeatNow: async () => {},
    runHeartbeatOnce: async () => ({ status: "ran" as const, durationMs: 0 }),
    runCommandWithTimeout: async () => ({
      code: 0,
      signal: null as NodeJS.Signals | null,
      killed: false,
      termination: "exit" as const,
      stdout: "",
      stderr: "",
    }),
    formatNativeDependencyHint: (h: { packageName: string }) => h.packageName,
  } as unknown as PluginRuntimeSystem;
}
