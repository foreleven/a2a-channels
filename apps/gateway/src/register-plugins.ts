/**
 * Channel plugin registrations for the gateway.
 *
 * Add one registerXxxPlugin(host) call per OpenClaw channel plugin that
 * should be active.  No per-channel package is required – any community
 * plugin that conforms to the OpenClaw plugin API can be wired up here.
 */

import larkPlugin from "@larksuite/openclaw-lark";
import type { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";

// ---------------------------------------------------------------------------
// Lark / Feishu
// ---------------------------------------------------------------------------

export function registerLarkPlugin(host: OpenClawPluginHost): void {
  host.registerPlugin((api) => larkPlugin.default.register(api));
  console.info("[lark-register] @larksuite/openclaw-lark registered");
}

// ---------------------------------------------------------------------------
// Register all plugins with the host
// ---------------------------------------------------------------------------

export function registerAllPlugins(host: OpenClawPluginHost): void {
  registerLarkPlugin(host);
}
