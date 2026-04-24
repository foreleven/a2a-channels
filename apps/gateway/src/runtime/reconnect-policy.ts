export interface ReconnectDecision {
  attempt: number;
  delayMs: number;
}

export interface ReconnectPolicy {
  next(attempt: number): ReconnectDecision;
}

export interface CreateReconnectPolicyOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function createReconnectPolicy(
  options: CreateReconnectPolicyOptions = {},
): ReconnectPolicy {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 30000;

  return {
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
