/**
 * Manages the lifecycle of Feishu WebSocket monitors.
 *
 * Each enabled Feishu channel binding gets a dedicated WebSocket
 * connection managed by @larksuite/openclaw-lark's monitorFeishuProvider.
 * When a new binding is added or an existing one is updated the monitor
 * is restarted automatically.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Use createRequire to bypass the exports map and access CJS modules directly.
// This lets us require both the main package entry and internal submodules.
const _require = createRequire(import.meta.url);
const { monitorFeishuProvider } = _require('@larksuite/openclaw-lark') as typeof import('@larksuite/openclaw-lark');

// Locate the runtime-store so we can inject our custom PluginRuntime into
// LarkClient.runtime before the monitor starts dispatching messages.
const _larkPkgDir = dirname(
  _require.resolve('@larksuite/openclaw-lark'),
);
let _setLarkRuntime: ((rt: unknown) => void) | null = null;
try {
  const runtimeStore = _require(join(_larkPkgDir, 'src/core/runtime-store.js')) as {
    setLarkRuntime: (rt: unknown) => void;
  };
  _setLarkRuntime = runtimeStore.setLarkRuntime;
} catch {
  // Fallback: try LarkClient.setRuntime via the main package
  try {
    const larkClient = _require(join(_larkPkgDir, 'src/core/lark-client.js')) as {
      LarkClient: { setRuntime: (rt: unknown) => void };
    };
    _setLarkRuntime = (rt: unknown) => larkClient.LarkClient.setRuntime(rt);
  } catch {
    console.warn('[monitor] could not locate LarkClient runtime setter – A2A dispatch may fail');
  }
}

import { buildOpenClawConfig, listChannelBindings } from '../store/index.js';
import { buildPluginRuntime } from './plugin-runtime.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MonitorHandle {
  abortController: AbortController;
  accountId: string;
  promise: Promise<void>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const monitors = new Map<string, MonitorHandle>();
let runtimeInstance: ReturnType<typeof buildPluginRuntime> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getRuntime() {
  if (!runtimeInstance) {
    runtimeInstance = buildPluginRuntime();
  }
  return runtimeInstance;
}

async function startMonitor(accountId: string): Promise<void> {
  const existing = monitors.get(accountId);
  if (existing) {
    console.log(`[monitor] stopping existing monitor for account ${accountId}`);
    existing.abortController.abort();
    await existing.promise.catch(() => {});
    monitors.delete(accountId);
  }

  const cfg = buildOpenClawConfig();
  const runtime = getRuntime();

  const abortController = new AbortController();
  const runtimeEnv = {
    log: (...args: unknown[]) => console.log(`[feishu:${accountId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[feishu:${accountId}]`, ...args),
    exit: (code: number) => process.exit(code),
  };

  console.log(`[monitor] starting Feishu WebSocket monitor for account: ${accountId}`);

  const promise = monitorFeishuProvider({
    config: cfg as never,
    runtime: runtimeEnv,
    accountId,
    abortSignal: abortController.signal,
  }).catch((err: unknown) => {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.error(`[monitor] account ${accountId} monitor error:`, String(err));
    }
  });

  // Inject our custom PluginRuntime into the LarkClient singleton BEFORE the
  // monitor starts dispatching events. This ensures all downstream dispatch
  // calls (LarkClient.runtime.channel.reply.dispatchReplyFromConfig etc.)
  // go through our A2A bridge rather than trying to call an LLM.
  if (_setLarkRuntime) {
    _setLarkRuntime(runtime);
    console.log('[monitor] LarkClient runtime injected');
  }

  monitors.set(accountId, { abortController, accountId, promise });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start (or restart) monitors for all enabled Feishu channel bindings.
 * Stops monitors for accounts that are no longer present in the store.
 */
export async function syncMonitors(): Promise<void> {
  const bindings = listChannelBindings().filter(
    (b) => b.enabled && b.channelType === 'feishu',
  );

  // Stop monitors for removed bindings
  const activeIds = new Set(bindings.map((b) => b.accountId));
  for (const [accountId, handle] of monitors.entries()) {
    if (!activeIds.has(accountId)) {
      console.log(`[monitor] stopping monitor for removed account: ${accountId}`);
      handle.abortController.abort();
      await handle.promise.catch(() => {});
      monitors.delete(accountId);
    }
  }

  // Start monitors for new bindings
  for (const binding of bindings) {
    if (!monitors.has(binding.accountId)) {
      await startMonitor(binding.accountId);
    }
  }
}

/**
 * Restart the monitor for a single account.
 * Called when a binding is created or updated.
 */
export async function restartMonitor(accountId: string): Promise<void> {
  await startMonitor(accountId);
}

/** Stop all active monitors gracefully. */
export async function stopAllMonitors(): Promise<void> {
  for (const [accountId, handle] of monitors.entries()) {
    console.log(`[monitor] stopping monitor for account: ${accountId}`);
    handle.abortController.abort();
    await handle.promise.catch(() => {});
    monitors.delete(accountId);
  }
}
