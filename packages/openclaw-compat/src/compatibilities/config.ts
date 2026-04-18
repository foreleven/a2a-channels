import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeConfig = PluginRuntime["config"];

/**
 * Build the `config` surface of a `PluginRuntime`.
 *
 * `loadConfig` delegates to the injected callback so the gateway can keep
 * the runtime free of any direct store dependency.  `writeConfigFile` is a
 * no-op because the gateway manages config through its own store.
 */
export function buildConfigCompat(
  getConfig: () => Record<string, unknown>,
): PluginRuntimeConfig {
  return {
    loadConfig: () =>
      getConfig() as ReturnType<PluginRuntimeConfig["loadConfig"]>,
    writeConfigFile: async () => {},
  };
}
