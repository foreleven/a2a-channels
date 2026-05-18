/**
 * Shared types for the relay CLI.
 *
 * The gateway's `GET /api/agents/:id/runner-config` endpoint returns a
 * `RunnerConfig` object that the relay CLI uses to set up the executor and
 * the WebSocket tunnel.
 */

export type ACPRemoteExecutorType = "claude-code" | "codex";
export type ACPRemotePermission =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

interface ACPRemoteExecutorConfigBase {
  readonly type: ACPRemoteExecutorType;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly permission?: ACPRemotePermission;
  readonly timeoutMs?: number;
}

/** Claude Code ACP stdio executor configuration stored server-side. */
export interface ClaudeCodeExecutorConfig
  extends ACPRemoteExecutorConfigBase {
  readonly type: "claude-code";
}

/** Codex ACP stdio executor configuration stored server-side. */
export interface CodexExecutorConfig extends ACPRemoteExecutorConfigBase {
  readonly type: "codex";
}

export type RelayExecutorConfig =
  | ClaudeCodeExecutorConfig
  | CodexExecutorConfig;

/** Response from `GET /api/agents/:id/runner-config`. */
export interface RunnerConfig {
  readonly agentId: string;
  readonly name: string;
  /** WebSocket URL the relay CLI should connect to, e.g. ws://gateway/ws/a2a/{id} */
  readonly gatewayWsUrl: string;
  readonly executor: RelayExecutorConfig;
}

/** Local relay credentials (gateway URL + agentId + relayToken). */
export interface RelayCredentials {
  readonly gatewayUrl: string;
  readonly agentId: string;
  readonly relayToken: string;
}
