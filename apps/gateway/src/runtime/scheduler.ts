export interface RuntimeScheduler {
  start(): void;
  stop(): Promise<void>;
}

export const RuntimeScheduler = Symbol.for("runtime.RuntimeScheduler");
