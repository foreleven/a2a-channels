/**
 * Echo A2A Agent Server
 *
 * A minimal A2A-compliant agent that echoes every inbound message back to
 * the sender.  Useful for testing the gateway end-to-end without a real LLM.
 *
 * Start with:
 *   bun run src/echo-agent/index.ts
 *
 * The agent will listen on port 3001 (or $ECHO_AGENT_PORT) and expose:
 *   GET  /.well-known/agent-card.json  →  AgentCard metadata
 *   POST /a2a/jsonrpc                  →  JSON-RPC 2.0 endpoint
 *   POST /a2a/rest                     →  HTTP+JSON/REST endpoint
 */

import crypto from "node:crypto";
import express from "express";
import { AGENT_CARD_PATH, type AgentCard, type Message } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  restHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env["ECHO_AGENT_PORT"] ?? 3001);
const BASE_URL = process.env["ECHO_AGENT_URL"] ?? `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const agentCard: AgentCard = {
  name: "Echo Agent",
  description: "Echoes every inbound message back to the sender verbatim.",
  url: `${BASE_URL}/a2a/jsonrpc`,
  protocolVersion: "0.3.0",
  version: "0.1.0",
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Mirror the user message back",
      tags: ["echo", "test"],
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  additionalInterfaces: [
    { url: `${BASE_URL}/a2a/jsonrpc`, transport: "JSONRPC" },
    { url: `${BASE_URL}/a2a/rest`, transport: "HTTP+JSON" },
  ],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class EchoExecutor implements AgentExecutor {
  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const parts = requestContext.userMessage.parts ?? [];
    const textParts = parts.filter(
      (p): p is Message["parts"][number] & { kind: "text"; text: string } =>
        p.kind === "text",
    );
    const userText = textParts
      .map((p) => p.text)
      .join("\n")
      .trim();

    const replyText = userText ? `Echo: ${userText}` : "(empty message)";

    eventBus.publish({
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      parts: [{ kind: "text", text: replyText }],
    });

    eventBus.finished();
  }

  cancelTask = async (): Promise<void> => {};
}

// ---------------------------------------------------------------------------
// Request handler setup
// ---------------------------------------------------------------------------

const requestHandler = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  new EchoExecutor(),
);

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();

app.use(
  `/${AGENT_CARD_PATH}`,
  agentCardHandler({ agentCardProvider: requestHandler }),
);
app.use(
  "/a2a/jsonrpc",
  jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
);
app.use(
  "/a2a/rest",
  restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  console.log(`🤖 Echo A2A Agent listening on http://localhost:${PORT}`);
  console.log(`   Agent card: http://localhost:${PORT}/${AGENT_CARD_PATH}`);
  console.log(`   JSON-RPC:   POST http://localhost:${PORT}/a2a/jsonrpc`);
  console.log(`   REST:       POST http://localhost:${PORT}/a2a/rest`);
});

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});

export default server;
