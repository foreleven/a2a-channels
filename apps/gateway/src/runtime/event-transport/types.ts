/**
 * Runtime coordination event types.
 *
 * Two categories:
 * - BroadcastEvent: sent to ALL nodes (config changes, membership changes).
 * - DirectedCommand: sent to a SPECIFIC node to take an action on one binding.
 *
 * In single-instance mode both are in-process. In cluster mode broadcasts use
 * Redis pub/sub and directed commands use per-instance Redis channels.
 */

export type RuntimeBroadcastEvent =
  | { readonly type: "BindingChanged"; readonly bindingId: string }
  | { readonly type: "AgentChanged"; readonly agentId: string }
  | { readonly type: "NodeJoined"; readonly nodeId: string }
  | { readonly type: "NodeLeft"; readonly nodeId: string };

export type RuntimeDirectedCommand =
  | { readonly type: "AttachBinding"; readonly bindingId: string }
  | { readonly type: "DetachBinding"; readonly bindingId: string }
  | { readonly type: "RefreshBinding"; readonly bindingId: string };
