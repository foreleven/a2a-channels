import type { Redis } from "ioredis";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../../bootstrap/config.js";
import { RedisClientService } from "../../infra/redis-client.js";
import type { RuntimeEventBus } from "../event-transport/runtime-event-bus.js";
import type {
  RuntimeBroadcastEvent,
  RuntimeDirectedCommand,
} from "../event-transport/types.js";

const BROADCAST_CHANNEL = "a2a:runtime:broadcast";

/** Builds the Redis pub/sub channel dedicated to one runtime node. */
function directedChannel(nodeId: string): string {
  return `a2a:runtime:node:${nodeId}`;
}

/**
 * Redis pub/sub implementation of RuntimeEventBus for cluster mode.
 *
 * Broadcasts are published to a shared Redis channel and all nodes receive
 * them via their own subscriber connection.
 *
 * Directed commands are published to a per-node channel so only the target
 * node receives them.
 *
 * Call connect() before first use and disconnect() on shutdown.
 */
@injectable()
export class RedisRuntimeEventBus implements RuntimeEventBus {
  private subscriber: Redis | null = null;
  private broadcastHandlers: Array<(e: RuntimeBroadcastEvent) => void> = [];
  private directedHandlers: Array<(c: RuntimeDirectedCommand) => void> = [];

  /** Receives Redis access and node identity for pub/sub routing. */
  constructor(
    @inject(RedisClientService)
    private readonly redisService: RedisClientService,
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  /** Opens the subscriber connection and subscribes to broadcast and directed channels. */
  async connect(): Promise<void> {
    if (this.subscriber) {
      return;
    }

    const sub = this.redisService.createSubscriber();

    sub.on("message", (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    try {
      await sub.subscribe(
        BROADCAST_CHANNEL,
        directedChannel(this.config.nodeId),
      );
    } catch (err) {
      try {
        await sub.quit();
      } catch {
        sub.disconnect();
      }
      throw err;
    }

    this.subscriber = sub;
  }

  /** Closes the subscriber connection used for runtime events. */
  async disconnect(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
  }

  /** Publishes a cluster-wide runtime event without awaiting subscriber delivery. */
  async broadcast(event: RuntimeBroadcastEvent): Promise<void> {
    const payload = JSON.stringify({ kind: "broadcast", event });
    await this.redisService.getClient().publish(BROADCAST_CHANNEL, payload);
  }

  /** Publishes a command to one runtime node's directed Redis channel. */
  async sendDirected(
    nodeId: string,
    command: RuntimeDirectedCommand,
  ): Promise<void> {
    const payload = JSON.stringify({ kind: "directed", command });
    await this.redisService.getClient().publish(directedChannel(nodeId), payload);
  }

  /** Registers a broadcast handler and returns its unsubscribe callback. */
  onBroadcast(handler: (event: RuntimeBroadcastEvent) => void): () => void {
    this.broadcastHandlers.push(handler);
    return () => {
      this.broadcastHandlers = this.broadcastHandlers.filter(
        (h) => h !== handler,
      );
    };
  }

  /** Registers a directed-command handler and returns its unsubscribe callback. */
  onDirectedCommand(
    handler: (command: RuntimeDirectedCommand) => void,
  ): () => void {
    this.directedHandlers.push(handler);
    return () => {
      this.directedHandlers = this.directedHandlers.filter(
        (h) => h !== handler,
      );
    };
  }

  /** Parses and validates Redis messages before dispatching them to local handlers. */
  private handleMessage(channel: string, message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      console.error("[redis-event-bus] received unparseable message");
      return;
    }

    if (!isObject(parsed)) {
      return;
    }

    if (parsed["kind"] === "broadcast") {
      const event = parsed["event"];
      if (isBroadcastEvent(event)) {
        for (const handler of this.broadcastHandlers) {
          handler(event);
        }
      }
    } else if (parsed["kind"] === "directed" && channel !== BROADCAST_CHANNEL) {
      const command = parsed["command"];
      if (isDirectedCommand(command)) {
        for (const handler of this.directedHandlers) {
          handler(command);
        }
      }
    }
  }
}

/** Narrows unknown Redis payloads to plain records. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates the small discriminated union of broadcast runtime events. */
function isBroadcastEvent(v: unknown): v is RuntimeBroadcastEvent {
  if (!isObject(v)) return false;
  return (
    v["type"] === "BindingChanged" ||
    v["type"] === "AgentChanged" ||
    v["type"] === "NodeJoined" ||
    v["type"] === "NodeLeft"
  );
}

/** Validates the small discriminated union of directed runtime commands. */
function isDirectedCommand(v: unknown): v is RuntimeDirectedCommand {
  if (!isObject(v)) return false;
  return (
    v["type"] === "AttachBinding" ||
    v["type"] === "DetachBinding" ||
    v["type"] === "RefreshBinding"
  );
}
