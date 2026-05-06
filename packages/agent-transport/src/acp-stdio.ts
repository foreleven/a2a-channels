/**
 * ACP stdio transport for local Agent Client Protocol processes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ACPStdioAgentConfig,
  AgentRequest,
  AgentResponse,
  AgentTransport,
  AgentTransportContext,
} from "./transport.js";

interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  permission: string;
  timeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Agent transport implementation backed by ACP-compatible stdio processes. */
export class ACPStdioTransport implements AgentTransport {
  readonly protocol = "acp";
  private readonly processPool: ACPStdioAgentProcessPool;

  constructor(
    config: ACPStdioAgentConfig,
    context?: AgentTransportContext,
  ) {
    this.processPool = new ACPStdioAgentProcessPool(config, context);
  }

  send(request: AgentRequest): Promise<AgentResponse> {
    return this.processPool.send(request);
  }

  start(): Promise<void> {
    return this.processPool.start();
  }

  stop(): Promise<void> {
    return this.processPool.stop();
  }
}

class ACPStdioAgentProcessPool {
  private readonly workers = new Map<string, ACPStdioAccountWorker>();
  private stopping = false;

  constructor(
    private readonly config: ACPStdioAgentConfig,
    private readonly context?: AgentTransportContext,
  ) {}

  async send(request: AgentRequest): Promise<AgentResponse> {
    if (this.stopping) {
      return { text: "(agent unavailable: ACP stdio transport is stopping)" };
    }

    const worker = this.getOrCreateWorker(request.accountId);

    try {
      return await worker.send(request);
    } catch (error) {
      if (this.workers.get(request.accountId) === worker) {
        this.workers.delete(request.accountId);
      }
      await worker.stop();
      console.error("[acp stdio] agent request failed:", String(error));
      return { text: `(agent unavailable: ${String(error)})` };
    }
  }

  async start(): Promise<void> {
    // Account-scoped workers are created lazily because accountId is request context.
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const allWorkers = Array.from(this.workers.values());
    this.workers.clear();
    await Promise.all(allWorkers.map((worker) => worker.stop()));
  }

  private getOrCreateWorker(accountId: string): ACPStdioAccountWorker {
    let worker = this.workers.get(accountId);
    if (!worker) {
      worker = new ACPStdioAccountWorker(
        accountId,
        parseCommandSpec(this.config, accountId, this.context),
      );
      this.workers.set(accountId, worker);
    }

    return worker;
  }
}

class ACPStdioAccountWorker {
  private readonly process: ACPStdioAgentProcess;

  constructor(
    readonly accountId: string,
    command: CommandSpec,
  ) {
    this.process = new ACPStdioAgentProcess(command);
  }

  send(request: AgentRequest): Promise<AgentResponse> {
    return this.process.send(request);
  }

  stop(): Promise<void> {
    return this.process.stop();
  }
}

class ACPStdioAgentProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly sessions = new Map<string, string>();
  private readonly activeTextBuffers = new Map<string, string[]>();
  private readonly client: ACPStdioClientCallbacks;
  private turnQueue = Promise.resolve();
  private stopping = false;

  constructor(private readonly command: CommandSpec) {
    this.client = new ACPStdioClientCallbacks(
      this.activeTextBuffers,
      command.permission,
    );
  }

  start(): Promise<void> {
    return this.initialize();
  }

  send(request: AgentRequest): Promise<AgentResponse> {
    const turn = this.turnQueue.then(() => this.sendSerialized(request));
    this.turnQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.child = null;
    this.connection = null;
    this.initializePromise = null;
    this.sessions.clear();
    this.activeTextBuffers.clear();

    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async sendSerialized(request: AgentRequest): Promise<AgentResponse> {
    await this.initialize();
    const connection = this.requireConnection();
    // Each account has its own process so no accountId prefix is needed here.
    const sessionKey = request.sessionKey ?? "default";
    const sessionId = await this.getOrCreateSession(sessionKey);
    const collectedText: string[] = [];
    this.activeTextBuffers.set(sessionId, collectedText);

    try {
      const response = await withTimeout(
        connection.prompt({
          sessionId,
          prompt: [{ type: "text", text: request.userMessage }],
        }),
        this.command.timeoutMs,
        'ACP request "session/prompt"',
      );

      if (response.stopReason === "cancelled") {
        return { text: "(agent cancelled)" };
      }

      const text = collectedText.join("").trim();
      return { text: text || "(no response from agent)" };
    } finally {
      this.activeTextBuffers.delete(sessionId);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      try {
        await mkdir(this.command.cwd, { recursive: true });
      } catch (err) {
        throw new Error(
          `[acp stdio] failed to create working directory "${this.command.cwd}": ${String(err)}`,
        );
      }
      this.startChild();
      const connection = this.requireConnection();
      await withTimeout(
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "a2a-channels-gateway",
            version: "0.1.0",
          },
        }),
        this.command.timeoutMs,
        'ACP request "initialize"',
      );
    })();

    return this.initializePromise;
  }

  private async getOrCreateSession(sessionKey: string): Promise<string> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const response = await withTimeout(
      this.requireConnection().newSession({
        cwd: this.command.cwd,
        mcpServers: [],
      }),
      this.command.timeoutMs,
      'ACP request "session/new"',
    );

    this.sessions.set(sessionKey, response.sessionId);
    return response.sessionId;
  }

  private startChild(): void {
    if (this.child) return;

    const child = spawn(this.command.command, this.command.args, {
      cwd: this.command.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout);
    const stream = acp.ndJsonStream(input, output);
    this.connection = new acp.ClientSideConnection(() => this.client, stream);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.error("[acp stdio stderr]", text);
    });
    child.on("error", (error) => {
      this.clearConnection();
      console.error("[acp stdio] failed to start:", String(error));
    });
    child.on("exit", (code, signal) => {
      const wasStopping = this.stopping;
      this.clearConnection();
      this.stopping = false;
      if (wasStopping) return;

      console.error(
        `[acp stdio] exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
      );
    });
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP stdio process is not connected");
    }

    return this.connection;
  }

  private clearConnection(): void {
    this.child = null;
    this.connection = null;
    this.initializePromise = null;
    this.sessions.clear();
    this.activeTextBuffers.clear();
  }
}

class ACPStdioClientCallbacks implements acp.Client {
  constructor(
    private readonly activeTextBuffers: Map<string, string[]>,
    private readonly permission: string,
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const preferred = params.options.find(
      (option) => option.kind === this.permission,
    );
    const fallback =
      preferred ??
      params.options.find((option) => option.kind === "reject_once") ??
      params.options.find((option) => option.kind === "reject_always") ??
      params.options[0];

    if (!fallback) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: fallback.optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const buffer = this.activeTextBuffers.get(params.sessionId);
    if (!buffer) return;

    const text = extractAgentMessageText(params.update);
    if (text) buffer.push(text);
  }
}

function extractAgentMessageText(update: acp.SessionUpdate): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  return update.content.type === "text" ? update.content.text : "";
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseCommandSpec(
  config: ACPStdioAgentConfig,
  accountId: string,
  context?: AgentTransportContext,
): CommandSpec {
  const command = config.command.trim();
  const args = [...(config.args ?? [])];

  const acpBasePath = process.env["ACP_BASE_PATH"];
  const agentName = context?.agentName;
  if (acpBasePath && agentName && !isFolderSafePathSegment(agentName)) {
    throw new Error(
      "ACP stdio agentName must be a folder-safe name using only letters, numbers, dots, underscores, and hyphens",
    );
  }
  const cwd =
    acpBasePath && agentName && accountId
      ? join(
          acpBasePath,
          agentName,
          sanitizePathSegment(accountId),
        )
      : (config.cwd ?? process.env["ACP_STDIO_CWD"] ?? process.cwd());

  const permission =
    config.permission ?? process.env["ACP_STDIO_PERMISSION"] ?? "reject_once";
  const timeoutMs = readPositiveIntegerValue(
    config.timeoutMs ?? process.env["ACP_STDIO_REQUEST_TIMEOUT_MS"],
    DEFAULT_REQUEST_TIMEOUT_MS,
  );

  if (command) {
    return { command, args, cwd, permission, timeoutMs };
  }

  throw new Error("ACP stdio config requires command");
}

function readPositiveIntegerValue(value: unknown, fallback: number): number {
  if (!value) return fallback;

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Strips directory separators and parent-directory components from a segment
 * that will be used as part of a filesystem path, preventing path traversal.
 */
function sanitizePathSegment(segment: string): string {
  return basename(segment);
}

function isFolderSafePathSegment(segment: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(segment) &&
    segment !== "." &&
    segment !== ".."
  );
}
