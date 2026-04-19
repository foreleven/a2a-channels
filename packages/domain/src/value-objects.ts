/**
 * Branded types for type-safe identifiers.
 *
 * Using brand types prevents accidentally passing an AgentId where a BindingId
 * is expected, catching mistakes at compile time.
 */

export type BindingId = string & { readonly __brand: "BindingId" };
export type AgentId = string & { readonly __brand: "AgentId" };

export function toBindingId(s: string): BindingId {
  return s as BindingId;
}

export function toAgentId(s: string): AgentId {
  return s as AgentId;
}
