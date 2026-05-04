import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as sleepTimeout } from "node:timers/promises";

function defaultGatewayUrl(env = process.env) {
  return env["GATEWAY_URL"] ?? `http://localhost:${env["PORT"] ?? 7890}`;
}

function commandLine(command, args) {
  return [command, ...args].join(" ");
}

export function createDevOrchestrator(options = {}) {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const spawnProcess = options.spawnProcess ?? spawn;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? sleepTimeout;
  const gatewayUrl = options.gatewayUrl ?? defaultGatewayUrl(env);
  const gatewayWait = {
    maxAttempts: options.gatewayWait?.maxAttempts ?? 120,
    intervalMs: options.gatewayWait?.intervalMs ?? 500,
  };
  const children = [];

  function startProcess(name, command, args) {
    logger.info(`[dev] starting ${name}: ${commandLine(command, args)}`);
    const child = spawnProcess(command, args, {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: "inherit",
    });
    children.push(child);
    return child;
  }

  async function waitForGateway() {
    const url = new URL("/api/agents", gatewayUrl).href;
    let lastError;

    for (let attempt = 1; attempt <= gatewayWait.maxAttempts; attempt += 1) {
      try {
        const response = await fetchImpl(url, { cache: "no-store" });
        if (response.ok) {
          logger.info(`[dev] gateway is ready: ${url}`);
          return;
        }
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }

      await sleep(gatewayWait.intervalMs);
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(`Gateway did not become ready at ${url}${detail}`);
  }

  async function stopAll() {
    for (const child of [...children].reverse()) {
      if (!child.killed) {
        child.kill();
      }
    }
  }

  async function startAll() {
    startProcess("gateway", "make", ["gateway"]);
    try {
      await waitForGateway();
    } catch (error) {
      await stopAll();
      throw error;
    }

    startProcess("echo-agent", "pnpm", ["run", "echo-agent"]);
    startProcess("web", "pnpm", ["run", "web"]);
    return children;
  }

  async function waitForAnyExit() {
    return new Promise((resolve) => {
      for (const child of children) {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      }
    });
  }

  return {
    startAll,
    stopAll,
    waitForAnyExit,
  };
}

async function main() {
  const orchestrator = createDevOrchestrator();

  const shutdown = async () => {
    await orchestrator.stopAll();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await orchestrator.startAll();
    const result = await orchestrator.waitForAnyExit();
    await orchestrator.stopAll();
    process.exit(typeof result.code === "number" ? result.code : 1);
  } catch (error) {
    console.error(error);
    await orchestrator.stopAll();
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
