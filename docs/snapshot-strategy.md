# Snapshot Strategy

The gateway currently has an event table and read-model projection tables, but it does not have aggregate snapshot tables.

This document clarifies the difference and proposes a snapshot strategy.

## Projection table vs aggregate snapshot

### Projection table

A projection table is optimized for queries and UI/runtime reads.

Current projection tables:

- `channel_bindings`
- `agents`

They are derived from domain events and can be rebuilt from the `events` table.

### Aggregate snapshot

An aggregate snapshot is optimized for command-side aggregate rehydration.

It stores the internal state of one aggregate at a specific stream version so the repository does not need to replay the whole stream every time.

A snapshot is not the source of truth. The event stream remains the source of truth.

## Current issue

Current repositories load aggregates by replaying all events in the stream:

```text
repository.findById(id)
  -> eventStore.load(streamId)
  -> Aggregate.reconstitute(all events)
```

This is simple and correct, but it becomes slower as streams grow.

## Recommended schema

Use one generic snapshot table first:

```prisma
model AggregateSnapshot {
  id              String   @id @default(uuid())
  streamId        String   @map("stream_id")
  streamVersion   Int      @map("stream_version")
  aggregateType   String   @map("aggregate_type")
  payload         String
  createdAt       DateTime @default(now()) @map("created_at")

  @@unique([streamId, streamVersion])
  @@index([streamId, streamVersion])
  @@map("aggregate_snapshots")
}
```

For this codebase, `payload` can store the aggregate snapshot returned by `aggregate.snapshot()` plus any extra internal state required for rehydration, such as `isDeleted` if deleted aggregates must be loaded.

## Repository loading algorithm

```text
find latest snapshot for streamId
  -> if snapshot exists:
       create aggregate from snapshot
       load events after snapshot.streamVersion
       apply remaining events
     else:
       load all events
       reconstitute aggregate
```

This requires either:

- aggregate constructors that can rehydrate from snapshots, or
- `reconstituteFromSnapshot(snapshot, eventsAfterSnapshot)` factory methods.

## Repository saving algorithm

```text
append pending events with optimistic concurrency
  -> clear pending events
  -> optionally write aggregate snapshot
  -> publish events
```

Snapshot writes should happen after event append succeeds. If snapshot writing fails, the event stream is still valid; the next load can fall back to replay.

## Snapshot frequency

Recommended initial policy:

- write a snapshot every 50 events per stream, or
- write a snapshot after every command for these low-volume config aggregates

Because `ChannelBinding` and `AgentConfig` streams are likely low-volume, snapshotting after every successful save is acceptable and keeps implementation simple.

## Deleted aggregates

Deletion currently appends a deleted event and `findById()` returns `null` after rehydration.

Snapshot strategy should preserve this behavior:

- either snapshot deleted state with `isDeleted: true`
- or skip deleted snapshots and rely on replaying the delete event

The first option is faster and more explicit.

## Interaction with projections

Do not replace `channel_bindings` and `agents` with aggregate snapshots.

Keep all three concepts separate:

```text
events                 source of truth
aggregate_snapshots    command-side rehydration cache
channel_bindings/agents query/runtime read models
```

## Migration path

1. Add `aggregate_snapshots` Prisma model.
2. Add `SnapshotStore` interface.
3. Implement `PrismaSnapshotStore`.
4. Add aggregate snapshot rehydration APIs.
5. Update event-sourced repositories to load latest snapshot first.
6. Write snapshots after successful event append.
7. Add tests:
   - load with no snapshot
   - load with snapshot plus later events
   - stale snapshot fallback
   - deleted aggregate snapshot returns `null`
