/**
 * Shared types for the relay CLI.
 *
 * The gateway's `GET /api/agents/:id/runner-config` endpoint returns a
 * `RunnerConfig` object that the relay CLI uses to set up the executor and
 * the WebSocket tunnel.
 */

/** Executor configuration stored server-side for a ws-tunnel agent. */
export interface ClaudeCodeExecutorConfig {
  readonly type: "claude-code";
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly maxTurns?: number;
  readonly allowedTools?: readonly string[];
}

/** Response from `GET /api/agents/:id/runner-config`. */
export interface RunnerConfig {
  readonly agentId: string;
  readonly name: string;
  /** WebSocket URL the relay CLI should connect to, e.g. ws://gateway/ws/a2a/{id} */
  readonly gatewayWsUrl: string;
  readonly executor: ClaudeCodeExecutorConfig;
}

/** Local relay credentials (gateway URL + agentId + relayToken). */
export interface RelayCredentials {
  readonly gatewayUrl: string;
  readonly agentId: string;
  readonly relayToken: string;
}
