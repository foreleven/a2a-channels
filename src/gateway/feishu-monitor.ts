/**
 * FeishuAdapter – thin ChannelAdapter for the Feishu/Lark channel.
 *
 * Only the Feishu-specific wiring lives here:
 *   • calling monitorFeishuProvider to open the WebSocket connection
 *   • injecting the PluginRuntime into LarkClient via the runtime-store
 *
 * All account lifecycle management (start/stop/restart bookkeeping) is
 * handled by MonitorManager in monitor-manager.ts.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { ChannelAdapter } from './channel-adapter.js';
import { buildOpenClawConfig } from '../store/index.js';

// Use createRequire to bypass the exports map and access CJS modules directly.
const _require = createRequire(import.meta.url);
const { monitorFeishuProvider } = _require('@larksuite/openclaw-lark') as typeof import('@larksuite/openclaw-lark');

// Locate the runtime-store so we can inject our custom PluginRuntime into
// LarkClient.runtime before the monitor starts dispatching messages.
const _larkPkgDir = dirname(_require.resolve('@larksuite/openclaw-lark'));
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
    console.warn('[feishu-adapter] could not locate LarkClient runtime setter – A2A dispatch may fail');
  }
}

export class FeishuAdapter implements ChannelAdapter {
  readonly channelType = 'feishu';

  async start(accountId: string, signal: AbortSignal): Promise<void> {
    const cfg = buildOpenClawConfig();
    const runtimeEnv = {
      log: (...args: unknown[]) => console.log(`[feishu:${accountId}]`, ...args),
      error: (...args: unknown[]) => console.error(`[feishu:${accountId}]`, ...args),
      exit: (code: number) => process.exit(code),
    };

    console.log(`[feishu-adapter] starting WebSocket monitor for account: ${accountId}`);

    await monitorFeishuProvider({
      config: cfg as never,
      runtime: runtimeEnv,
      accountId,
      abortSignal: signal,
    });
  }

  injectRuntime(runtime: unknown): void {
    if (_setLarkRuntime) {
      _setLarkRuntime(runtime);
      console.log('[feishu-adapter] LarkClient runtime injected');
    }
  }
}
