# Disable LeaderScheduler Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cluster mode fail fast until the DDD/OOP cluster scheduler design is complete, while preserving the single-instance runtime path.

**Architecture:** Keep `index.ts` and `GatewayServer` unchanged. Add a composition-root guard in `buildGatewayContainer()` so `CLUSTER_MODE=true` does not wire the incomplete `LeaderScheduler`; update tests and docs to state that `LeaderScheduler` is not a production component yet.

**Tech Stack:** TypeScript, Inversify, Node test runner, Prisma-backed gateway runtime.

---

### Task 1: Container Cluster Guard

**Files:**
- Modify: `apps/gateway/src/container/container.test.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`

- [ ] **Step 1: Write the failing test**

Add a container test asserting cluster mode fails fast with a clear message:

```ts
test("rejects cluster runtime mode until cluster scheduling is implemented", () => {
  assert.throws(
    () => buildGatewayContainer({ clusterMode: true }),
    /Cluster runtime mode is not implemented yet/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm typecheck`

Expected: failure because `buildGatewayContainer({ clusterMode: true })` currently succeeds or fails with a less intentional DI error.

- [ ] **Step 3: Write minimal implementation**

In `apps/gateway/src/bootstrap/container.ts`, add a guard immediately after resolving config in `buildGatewayContainer()`:

```ts
if (config.clusterMode) {
  throw new Error(
    "Cluster runtime mode is not implemented yet. Run with CLUSTER_MODE=false until Redis RuntimeEventBus, membership, binding leases, and directed scheduling are implemented.",
  );
}
```

Remove unused imports that become dead after the cluster branch is removed from `bindRuntime()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm typecheck`

Expected: PASS with no TypeScript errors.

### Task 2: Documentation Alignment

**Files:**
- Modify: `docs/architecture-design-zh.md`

- [ ] **Step 1: Update current-state section**

Clarify that Phase 1 production runtime is single-instance only, and `LeaderScheduler` is not wired for production.

- [ ] **Step 2: Update Phase 2 language**

Replace claims that single-instance and cluster differ only by `RuntimeEventBus` with a more precise statement: the desired long-term boundary is a transport/ownership layer swap, but current implementation disables cluster mode until Redis event transport, membership, leases, and scheduling are complete.

- [ ] **Step 3: Run a docs grep sanity check**

Run: `rg -n "LeaderScheduler|clusterMode|CLUSTER_MODE|唯一核心差别|只有一处" docs/architecture-design-zh.md`

Expected: all matches should describe cluster mode as future/disabled, not production-ready.

### Task 3: Final Verification

**Files:**
- No additional modifications expected.

- [ ] **Step 1: Run focused tests**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 2: Run checked-in test suite**

Run: `pnpm test`

Expected: PASS, unless unrelated existing failures are reported.
