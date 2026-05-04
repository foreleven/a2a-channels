import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const checkedFiles = [
  "apps/gateway/src/bootstrap/container.ts",
  "apps/gateway/src/container/container.test.ts",
  "apps/gateway/src/runtime/agent-client-registry.ts",
  "apps/gateway/src/runtime/agent-client-registry.test.ts",
  "apps/gateway/src/runtime/agent-clients.ts",
  "apps/gateway/src/runtime/connection/connection-manager.ts",
  "apps/gateway/src/runtime/connection/connection.ts",
  "apps/gateway/src/runtime/connection/reply-delivery.ts",
  "apps/gateway/src/runtime/connection/events.ts",
  "apps/gateway/src/runtime/connection/connection-status.ts",
  "apps/gateway/src/runtime/connection/reconnect-policy.ts",
  "apps/gateway/src/runtime/ownership-state.ts",
  "apps/gateway/src/runtime/runtime-assignment-service.ts",
  "apps/gateway/src/runtime/runtime-assignment-service.test.ts",
  "apps/gateway/src/runtime/runtime-command-handler.ts",
  "apps/gateway/package.json",
  "packages/agent-transport/package.json",
  "packages/agent-transport/src/a2a.ts",
  "packages/agent-transport/src/acp.ts",
  "packages/agent-transport/src/acp-stdio.ts",
  "packages/openclaw-compat/package.json",
  "packages/openclaw-compat/src/plugin-host.ts",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
];

describe("architecture boundaries", () => {
  test("runtime and transport code do not depend on the old core package", async () => {
    const offenders: string[] = [];

    for (const file of checkedFiles) {
      const absolutePath = resolve(repoRoot, file);
      const source = await readFile(absolutePath, "utf8");
      if (source.includes("@a2a-channels/core")) {
        offenders.push(relative(repoRoot, absolutePath));
      }
    }

    assert.deepEqual(offenders, []);
  });

  test("runtime status queries stay outside the runtime execution layer", async () => {
    const runtimeFiles = await readdir(resolve(repoRoot, "apps/gateway/src/runtime"));
    const adminReadModelFiles = runtimeFiles.filter(
      (file) =>
        file.includes("cluster-state-reader") ||
        file.includes("desired-state-query") ||
        file.includes("status-query-service"),
    );

    assert.deepEqual(adminReadModelFiles, []);
  });

  test("OpenClaw runtime composition stays inside RelayRuntime", async () => {
    const runtimeFiles = await readdir(resolve(repoRoot, "apps/gateway/src/runtime"));
    assert.equal(runtimeFiles.includes("openclaw-runtime-assembler.ts"), false);

    const relayRuntime = await readFile(
      resolve(repoRoot, "apps/gateway/src/runtime/relay-runtime.ts"),
      "utf8",
    );
    const container = await readFile(
      resolve(repoRoot, "apps/gateway/src/bootstrap/container.ts"),
      "utf8",
    );

    assert.equal(relayRuntime.includes("OpenClawRuntimeAssembler"), false);
    assert.equal(container.includes("OpenClawRuntimeAssembler"), false);
  });

  test("RelayRuntime does not wire ConnectionManager event callbacks", async () => {
    const relayRuntime = await readFile(
      resolve(repoRoot, "apps/gateway/src/runtime/relay-runtime.ts"),
      "utf8",
    );

    assert.equal(relayRuntime.includes("onConnectionStatus"), false);
    assert.equal(relayRuntime.includes("onAgentCallFailed"), false);
    assert.equal(relayRuntime.includes("handleOwnedConnectionStatus"), false);
  });

  test("RuntimeAssignmentService keeps connection status handling internal", async () => {
    const assignmentService = await readFile(
      resolve(repoRoot, "apps/gateway/src/runtime/runtime-assignment-service.ts"),
      "utf8",
    );

    assert.equal(assignmentService.includes("handleOwnedConnectionStatus"), false);
    assert.equal(assignmentService.includes("restartConnection:"), false);
  });
});
