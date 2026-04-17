/**
 * Channel plugin registrations for the gateway.
 *
 * Add one registerXxxPlugin(host) call per OpenClaw channel plugin that
 * should be active.  No per-channel package is required – any community
 * plugin that conforms to the OpenClaw plugin API can be wired up here.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";

declare module "@larksuite/openclaw-lark" {
  const plugin: { register(api: unknown): void };
  export default plugin;
}

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Lark / Feishu
// ---------------------------------------------------------------------------

function getLarkPkgDir(): string {
  try {
    return dirname(require.resolve("@larksuite/openclaw-lark/package.json"));
  } catch {
    throw new Error(
      "Could not resolve @larksuite/openclaw-lark. " +
        "Make sure it is listed in dependencies and installed.",
    );
  }
}

/**
 * Try to locate the Lark SDK's internal runtime setter.
 * Probes two known module paths to handle SDK version differences.
 */
function resolveLarkRuntimeInjector():
  | ((runtime: unknown) => void)
  | undefined {
  const larkPkgDir = getLarkPkgDir();
  try {
    const store = require(join(larkPkgDir, "src/core/runtime-store.js")) as {
      setLarkRuntime: (runtime: unknown) => void;
    };
    return store.setLarkRuntime;
  } catch {
    /* try next location */
  }

  try {
    const client = require(join(larkPkgDir, "src/core/lark-client.js")) as {
      LarkClient: { setRuntime: (runtime: unknown) => void };
    };
    return (runtime: unknown) => client.LarkClient.setRuntime(runtime);
  } catch {
    /* not found */
  }

  return undefined;
}

export function registerLarkPlugin(host: OpenClawPluginHost): void {
  const larkPkgDir = getLarkPkgDir();
  const { default: larkPlugin } = require(join(larkPkgDir, "index.js")) as {
    default: { register: (api: unknown) => void };
  };

  const injector = resolveLarkRuntimeInjector();
  if (injector) {
    host.setRuntimeInjector(injector);
  } else {
    console.warn(
      "[lark-register] could not locate Lark runtime setter; " +
        "runtime updates may not propagate into the Lark SDK",
    );
  }

  host.registerPlugin((api) => larkPlugin.register(api));
  console.info("[lark-register] @larksuite/openclaw-lark registered");
}

// ---------------------------------------------------------------------------
// Register all plugins with the host
// ---------------------------------------------------------------------------

export function registerAllPlugins(host: OpenClawPluginHost): void {
  registerLarkPlugin(host);
}
