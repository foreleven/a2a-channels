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
 *   POST /                             →  JSON-RPC 2.0 endpoint
 */

import crypto from 'node:crypto';
import type { AgentCard } from '@a2a-js/sdk';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
} from '@a2a-js/sdk/server';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env['ECHO_AGENT_PORT'] ?? 3001);
const BASE_URL = process.env['ECHO_AGENT_URL'] ?? `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

const agentCard: AgentCard = {
  name: 'Echo Agent',
  description: 'Echoes every inbound message back to the sender verbatim.',
  url: BASE_URL,
  protocolVersion: '0.3.0',
  version: '0.1.0',
  skills: [
    {
      id: 'echo',
      name: 'Echo',
      description: 'Mirror the user message back',
      tags: ['echo', 'test'],
    },
  ],
  capabilities: {
    streaming: false,
    pushNotifications: false,
  },
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class EchoExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    // Extract the text from the inbound message parts
    const parts = requestContext.userMessage.parts ?? [];
    const textParts = parts.filter(
      (p) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['kind'] === 'text',
    );
    const userText = textParts
      .map((p) => ((p as Record<string, unknown>)['text'] as string) ?? '')
      .join('\n')
      .trim();

    const replyText = userText ? `Echo: ${userText}` : '(empty message)';

    // Publish a Message reply directly (no Task wrapping for simple echo)
    eventBus.publish({
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'agent',
      contextId: requestContext.contextId,
      taskId: requestContext.taskId,
      parts: [{ kind: 'text', text: replyText }],
    });

    eventBus.finished();
  }

  cancelTask = async (_taskId: string): Promise<void> => {};
}

// ---------------------------------------------------------------------------
// JSON-RPC handler (standalone, no Express dependency)
// ---------------------------------------------------------------------------

const taskStore = new InMemoryTaskStore();
const executor = new EchoExecutor();

// DefaultRequestHandler wraps the executor with task lifecycle management
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

// ---------------------------------------------------------------------------
// Bun HTTP server
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Agent card endpoint
  if (req.method === 'GET' && url.pathname === '/.well-known/agent-card.json') {
    return new Response(JSON.stringify(agentCard, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // JSON-RPC endpoint – handles all A2A methods (tasks/send, tasks/get, etc.)
  if (req.method === 'POST' && url.pathname === '/') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    try {
      // Use the DefaultRequestHandler's JSON-RPC logic via the internal transport
      // handler, which handles method routing and task lifecycle.
      const { JsonRpcTransportHandler } = await import('@a2a-js/sdk/server');
      const transport = new JsonRpcTransportHandler(requestHandler);
      const result = await transport.handle(body);

      // result is either a single JSONRPCResponse or an AsyncGenerator (streaming)
      if (result && typeof result === 'object' && Symbol.asyncIterator in (result as object)) {
        // Collect streamed responses into an array (echo agent is non-streaming)
        const responses: unknown[] = [];
        for await (const chunk of result as AsyncIterable<unknown>) {
          responses.push(chunk);
        }
        const finalResponse = responses[responses.length - 1] ?? {};
        return new Response(JSON.stringify(finalResponse), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      // Log the full error server-side but only expose a generic message to clients
      console.error('[echo-agent] internal error:', err);
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: (body as Record<string, unknown>)?.['id'] ?? null,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

console.log(`🤖 Echo A2A Agent starting on http://localhost:${PORT}`);

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`✅ Echo agent listening on http://localhost:${PORT}`);
console.log(`   Agent card: http://localhost:${PORT}/.well-known/agent-card.json`);
console.log(`   JSON-RPC:   POST http://localhost:${PORT}/`);

process.on('SIGINT', () => {
  server.stop();
  process.exit(0);
});

export default server;
