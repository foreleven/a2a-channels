/**
 * Lark / Feishu channel plugin registration.
 *
 * Responsible for all @larksuite/openclaw-lark-specific wiring:
 *   1. Dynamically loading the npm package.
 *   2. Locating and registering the Lark SDK runtime setter so that any call
 *      to host.setRuntime() is automatically propagated into the SDK.
 *   3. Registering the plugin with the host via host.registerPlugin().
 *
 * Nothing in this file should be imported by channel-agnostic code.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";

const require = createRequire(import.meta.url);

/**
 * Resolve the root directory of the @larksuite/openclaw-lark package.
 * Uses require.resolve() anchored to this module's location so the result
 * is correct regardless of the process working directory.
 */
function getLarkPkgDir(): string {
  try {
    // Resolving package.json is more reliable under Bun than resolving the
    // bare package specifier and inferring the directory from its main entry.
    return dirname(require.resolve("@larksuite/openclaw-lark/package.json"));
  } catch {
    throw new Error(
      "Could not resolve @larksuite/openclaw-lark. " +
        "Make sure it is listed in dependencies and installed.",
    );
  }
}

/**
 * Load and register the @larksuite/openclaw-lark community plugin.
 *
 * Call this once during gateway startup, before creating account runners
 * or calling host.setRuntime().
 */
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
// Internal helpers
// ---------------------------------------------------------------------------

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
