/**
 * EventStore contract for a2a-channels.
 *
 * An append-only log of domain events, indexed by stream (one stream per
 * aggregate instance) and a global monotonic sequence number (for projections).
 */

// ---------------------------------------------------------------------------
// StoredEvent
// ---------------------------------------------------------------------------

export interface StoredEventMetadata {
  readonly occurredAt: string;
  readonly causedBy?: string;
}

export interface StoredEvent {
  /** UUID that uniquely identifies this event record. */
  readonly id: string;

  /**
   * Identifies the aggregate stream, e.g. `"ChannelBinding:some-uuid"` or
   * `"AgentConfig:some-uuid"`.
   */
  readonly streamId: string;

  /**
   * 1-based position of this event within its stream.
   * Used for optimistic concurrency checks.
   */
  readonly streamVersion: number;

  /** Versioned discriminant, e.g. `"ChannelBindingCreated.v1"`. */
  readonly eventType: string;

  /** The domain event payload (deserialized from JSON). */
  readonly payload: unknown;

  readonly metadata: StoredEventMetadata;

  /**
   * Monotonically increasing global sequence number across all streams.
   * Projections use this to replay events in insertion order.
   */
  readonly globalSeq: number;
}

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

/** Thrown when an optimistic concurrency conflict is detected. */
export class ConcurrencyError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly expectedVersion: number,
    public readonly actualVersion: number,
  ) {
    super(
      `Concurrency conflict on stream "${streamId}": expected version ${expectedVersion}, actual version ${actualVersion}`,
    );
    this.name = "ConcurrencyError";
  }
}

export interface NewStoredEvent {
  /** UUID. */
  readonly id: string;
  readonly streamId: string;
  /** 1-based position within the stream. */
  readonly streamVersion: number;
  readonly eventType: string;
  readonly payload: unknown;
  readonly metadata: StoredEventMetadata;
  readonly occurredAt: Date;
}

export interface EventStore {
  /**
   * Append `events` to `streamId`.
   *
   * `expectedVersion` is the number of events already in the stream before
   * this append.  Pass `0` for a new stream.  Throws `ConcurrencyError` if
   * the actual stream version doesn't match.
   */
  append(
    streamId: string,
    events: NewStoredEvent[],
    expectedVersion: number,
  ): Promise<void>;

  /** Load all events for `streamId` in version order. */
  load(streamId: string): Promise<StoredEvent[]>;

  /**
   * Iterate over all events in global insertion order, optionally starting
   * after `afterGlobalSeq` (exclusive).  Useful for rebuilding projections.
   */
  loadAll(afterGlobalSeq?: number): AsyncIterable<StoredEvent>;
}
