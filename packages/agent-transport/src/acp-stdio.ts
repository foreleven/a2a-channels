/**
 * ACP stdio client for local Agent Client Protocol processes such as Codex.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ACPStdioAgentConfig,
  AgentRequest,
  AgentResponse,
} from "./transport.js";

interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  permission: string;
  timeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Process pool for ACP-compatible stdio agents. */
export class ACPStdioClient {
  private readonly processes = new Map<string, ACPStdioAgentProcess>();

  async send(
    request: AgentRequest,
    config: ACPStdioAgentConfig,
  ): Promise<AgentResponse> {
    const command = parseCommandSpec(config);
    const key = JSON.stringify(command);
    let process = this.processes.get(key);
    if (!process) {
      process = new ACPStdioAgentProcess(command);
      this.processes.set(key, process);
    }

    try {
      return await process.send(request);
    } catch (error) {
      console.error("[acp stdio] agent request failed:", String(error));
      return { text: `(agent unavailable: ${String(error)})` };
    }
  }

  async start(config: ACPStdioAgentConfig): Promise<void> {
    const command = parseCommandSpec(config);
    const key = JSON.stringify(command);
    if (!this.processes.has(key)) {
      this.processes.set(key, new ACPStdioAgentProcess(command));
    }
  }

  async stop(config: ACPStdioAgentConfig): Promise<void> {
    const command = parseCommandSpec(config);
    const key = JSON.stringify(command);
    const process = this.processes.get(key);
    if (!process) return;

    this.processes.delete(key);
    await process.stop();
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
    const sessionKey = request.sessionKey ?? request.accountId ?? "default";
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

function parseCommandSpec(config: ACPStdioAgentConfig): CommandSpec {
  const command = config.command.trim();
  const args = [...(config.args ?? [])];
  const cwd = config.cwd ?? process.env["CODEX_ACP_CWD"] ?? process.cwd();
  const permission =
    config.permission ?? process.env["CODEX_ACP_PERMISSION"] ?? "reject_once";
  const timeoutMs = readPositiveIntegerValue(
    config.timeoutMs ?? process.env["CODEX_ACP_REQUEST_TIMEOUT_MS"],
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
