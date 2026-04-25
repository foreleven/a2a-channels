/** Lifecycle boundary for runtime desired-state schedulers. */
export interface RuntimeScheduler {
  /** Starts timer and event subscriptions that drive reconciliation. */
  start(): void;
  /** Stops scheduler timers/subscriptions and waits for cleanup. */
  stop(): Promise<void>;
}

/** DI token for the configured runtime scheduler implementation. */
export const RuntimeScheduler = Symbol.for("runtime.RuntimeScheduler");
