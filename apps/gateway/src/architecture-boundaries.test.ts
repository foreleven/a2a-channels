import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const checkedFiles = [
  "apps/gateway/src/bootstrap/container.ts",
  "apps/gateway/src/container/container.test.ts",
  "apps/gateway/src/http/routes/runtime.ts",
  "apps/gateway/src/runtime/agent-client-registry.ts",
  "apps/gateway/src/runtime/agent-client-registry.test.ts",
  "apps/gateway/src/runtime/agent-clients.ts",
  "apps/gateway/src/runtime/connection-manager.ts",
  "apps/gateway/src/runtime/node-runtime-state-store.ts",
  "apps/gateway/src/runtime/openclaw-config.ts",
  "apps/gateway/src/runtime/ownership-state.ts",
  "apps/gateway/src/runtime/runtime-assignment-service.ts",
  "apps/gateway/src/runtime/runtime-assignment-service.test.ts",
  "apps/gateway/src/runtime/runtime-desired-state-query.ts",
  "apps/gateway/src/runtime/runtime-node-state.ts",
  "apps/gateway/package.json",
  "packages/agent-transport/package.json",
  "packages/agent-transport/src/a2a.ts",
  "packages/agent-transport/src/acp.ts",
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
});
