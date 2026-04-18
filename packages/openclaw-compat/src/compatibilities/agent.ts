import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeAgent = PluginRuntime["agent"];

/**
 * Build the `agent` surface of a `PluginRuntime`.
 *
 * This gateway does not run embedded agents, so all methods are stubs that
 * return safe sentinel values without performing any real work.
 */
export function buildAgentCompat(): PluginRuntimeAgent {
  return {
    defaults: { model: "gpt-5.4", provider: "openai" },
    resolveAgentDir: () => "/tmp/a2a-channels",
    resolveAgentWorkspaceDir: () => "/tmp/a2a-channels",
    resolveAgentIdentity: () => ({ agentId: "main", name: "main" }),
    resolveThinkingDefault: () => "off",
    runEmbeddedAgent: async () => ({ meta: { durationMs: 0 } }),
    runEmbeddedPiAgent: async () => ({ meta: { durationMs: 0 } }),
    resolveAgentTimeoutMs: () => 30_000,
    ensureAgentWorkspace: async () => ({
      dir: "/tmp/a2a-channels",
      created: false,
    }),
    session: {
      resolveStorePath: () => "/tmp/a2a-sessions",
      loadSessionStore: () => ({}),
      saveSessionStore: async () => {},
      resolveSessionFilePath: () => "/tmp/a2a-sessions/session.json",
    },
  };
}
