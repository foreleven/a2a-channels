/** Next reconnect attempt number and delay selected by a policy. */
export interface ReconnectDecision {
  attempt: number;
  delayMs: number;
}

/** Strategy interface for converting retry attempts into reconnect delays. */
export interface ReconnectPolicy {
  /** Returns the delay decision for a 1-based reconnect attempt. */
  next(attempt: number): ReconnectDecision;
}

/** Tunables for the exponential reconnect policy. */
export interface CreateReconnectPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Creates an exponential backoff reconnect policy capped by maxDelayMs. */
export function createReconnectPolicy(
  options: CreateReconnectPolicyOptions = {},
): ReconnectPolicy {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  return {
    /** Calculates the capped exponential delay for one reconnect attempt. */
    next(attempt: number): ReconnectDecision {
      const safeAttempt = Math.max(1, attempt);
      const delayMs = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** (safeAttempt - 1),
      );

      return {
        attempt: safeAttempt,
        delayMs,
      };
    },
  };
}
