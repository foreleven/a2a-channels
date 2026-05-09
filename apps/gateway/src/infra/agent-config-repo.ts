import type {
  A2AAgentConfig,
  ACPAgentConfig,
  AgentConfigRepository,
  AgentConfigSnapshot,
  AgentProtocol,
  AgentProtocolConfig,
  WsTunnelAgentConfig,
  ClaudeCodeExecutorConfig,
} from "@agent-relay/domain";
import { AgentConfigAggregate } from "@agent-relay/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

function mapPrismaRowToSnapshot(row: {
  id: string;
  name: string;
  protocol: string;
  config: string;
  description: string | null;
  createdAt: Date;
}): AgentConfigSnapshot {
  return {
    id: row.id,
    name: row.name,
    protocol: parseAgentProtocol(row.protocol),
    config: parseAgentConfig(row.protocol, row.config),
    description: row.description ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Prisma-backed current-state repository for AgentConfig aggregates. */
@injectable()
export class AgentConfigStateRepository implements AgentConfigRepository {
  async findById(id: string): Promise<AgentConfigAggregate | null> {
    const row = await prisma.agent.findUnique({ where: { id } });
    if (!row) return null;
    return AgentConfigAggregate.fromSnapshot(mapPrismaRowToSnapshot(row));
  }

  async findAll(): Promise<AgentConfigSnapshot[]> {
    const rows = await prisma.agent.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRowToSnapshot);
  }

  async save(aggregate: AgentConfigAggregate): Promise<void> {
    const pending = aggregate.pendingEvents;
    if (pending.length === 0) return;

    await prisma.$transaction(async (tx) => {
      if (aggregate.isDeleted) {
        await tx.agent.deleteMany({ where: { id: aggregate.id } });
      } else {
        const snapshot = aggregate.snapshot();
        await tx.agent.upsert({
          where: { id: snapshot.id },
          create: {
            id: snapshot.id,
            name: snapshot.name,
            protocol: snapshot.protocol,
            config: JSON.stringify(snapshot.config),
            description: snapshot.description,
            createdAt: new Date(snapshot.createdAt),
          },
          update: {
            name: snapshot.name,
            protocol: snapshot.protocol,
            config: JSON.stringify(snapshot.config),
            description: snapshot.description,
          },
        });
      }

    });

    aggregate.clearPendingEvents();
  }
}

function parseAgentProtocol(value: string): AgentProtocol {
  if (value === "acp") return "acp";
  if (value === "ws-tunnel") return "ws-tunnel";
  return "a2a";
}

function parseAgentConfig(
  protocolValue: string,
  value: string,
): AgentProtocolConfig {
  try {
    const parsed = JSON.parse(value) as unknown;
    const protocol = parseAgentProtocol(protocolValue);
    if (protocol === "a2a" && isA2AAgentConfig(parsed)) {
      return {
        url: parsed.url,
        contextIdStrategy: parseA2AContextIdStrategy(
          parsed.contextIdStrategy,
        ),
      };
    }
    if (protocol === "acp" && isACPAgentConfig(parsed)) {
      return {
        transport: "stdio",
        command: parsed.command,
        args: parsed.args,
        cwd: parsed.cwd,
        permission: parsed.permission,
        timeoutMs: parsed.timeoutMs,
      };
    }
    if (protocol === "ws-tunnel" && isWsTunnelAgentConfig(parsed)) {
      return {
        transport: "ws-tunnel",
        relayToken: parsed.relayToken,
        executor: parseClaudeCodeExecutorConfig(parsed.executor),
        timeoutMs: typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : undefined,
      };
    }
    // Warn about unrecognised configs (e.g. previously persisted ACP REST rows)
    // so operators know they need to re-configure the agent.
    console.warn(
      `[agent-config-repo] agent config for protocol "${protocolValue}" did not match any known schema; falling back to inert default. Stored value: ${value}`,
    );
  } catch {
    // Fall through to an inert local default for corrupt rows.
  }

  return parseAgentProtocol(protocolValue) === "acp"
    ? { transport: "stdio", command: "" }
    : parseAgentProtocol(protocolValue) === "ws-tunnel"
      ? { transport: "ws-tunnel", relayToken: "", executor: { type: "claude-code" } }
      : { url: "" };
}

function isA2AAgentConfig(value: unknown): value is A2AAgentConfig {
  return isObject(value) && typeof value.url === "string";
}

function parseA2AContextIdStrategy(
  value: unknown,
): A2AAgentConfig["contextIdStrategy"] {
  return value === "server-assigned" ? "server-assigned" : "client-provided";
}

function isACPAgentConfig(value: unknown): value is ACPAgentConfig {
  if (!isObject(value)) return false;
  if (value.transport === "stdio") {
    return (
      typeof value.command === "string" &&
      (value.args === undefined ||
        (Array.isArray(value.args) &&
          value.args.every((arg) => typeof arg === "string"))) &&
      (value.cwd === undefined || typeof value.cwd === "string") &&
      (value.permission === undefined ||
        value.permission === "allow_once" ||
        value.permission === "allow_always" ||
        value.permission === "reject_once" ||
        value.permission === "reject_always") &&
      (value.timeoutMs === undefined ||
        (typeof value.timeoutMs === "number" &&
          Number.isInteger(value.timeoutMs) &&
          value.timeoutMs > 0))
    );
  }

  return false;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWsTunnelAgentConfig(value: unknown): value is {
  transport: "ws-tunnel";
  relayToken: string;
  executor: unknown;
  timeoutMs?: number;
} {
  if (!isObject(value)) return false;
  return (
    value.transport === "ws-tunnel" && typeof value.relayToken === "string"
  );
}

function parseClaudeCodeExecutorConfig(
  raw: unknown,
): ClaudeCodeExecutorConfig {
  if (!isObject(raw) || raw.type !== "claude-code") {
    return { type: "claude-code" };
  }
  return {
    type: "claude-code",
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.systemPrompt === "string"
      ? { systemPrompt: raw.systemPrompt }
      : {}),
    ...(typeof raw.maxTurns === "number" ? { maxTurns: raw.maxTurns } : {}),
    ...(Array.isArray(raw.allowedTools) &&
    raw.allowedTools.every((t) => typeof t === "string")
      ? { allowedTools: raw.allowedTools as string[] }
      : {}),
  };
}
