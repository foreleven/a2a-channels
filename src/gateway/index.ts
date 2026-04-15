/**
 * A2A Channels Gateway – main HTTP server.
 *
 * Uses Bun's built-in `Bun.serve()` for high-performance request handling.
 *
 * Routes:
 *   GET  /               → Web UI
 *   GET  /api/channels   → list channel bindings
 *   POST /api/channels   → create channel binding
 *   PATCH /api/channels/:id → update channel binding
 *   DELETE /api/channels/:id → delete channel binding
 *   GET  /api/agents     → list agent configs
 *   POST /api/agents     → create agent config
 *   PATCH /api/agents/:id → update agent config
 *   DELETE /api/agents/:id → delete agent config
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listChannelBindings,
  getChannelBinding,
  createChannelBinding,
  updateChannelBinding,
  deleteChannelBinding,
  listAgentConfigs,
  getAgentConfig,
  createAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
} from '../store/index.js';
import { syncMonitors, restartMonitor, stopAllMonitors } from './feishu-monitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

const PORT = Number(process.env['PORT'] ?? 8080);

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function notFound(msg = 'Not found'): Response {
  return json({ error: msg }, 404);
}

function badRequest(msg: string): Response {
  return json({ error: msg }, 400);
}

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function matchPath(url: URL, prefix: string): string | null {
  if (url.pathname === prefix) return '';
  if (url.pathname.startsWith(prefix + '/')) return url.pathname.slice(prefix.length + 1);
  return null;
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();

  // ---- Static Web UI ----
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
    try {
      const html = await readFile(join(WEB_DIR, 'index.html'), 'utf-8');
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch {
      return new Response('<h1>Web UI not found</h1>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }
  }

  // ---- Channel bindings API ----
  const channelsPath = matchPath(url, '/api/channels');
  if (channelsPath !== null) {
    if (method === 'GET' && channelsPath === '') {
      return json(listChannelBindings());
    }

    if (method === 'POST' && channelsPath === '') {
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return badRequest('Invalid JSON body');
      }
      if (!body['name'] || !body['channelConfig'] || !body['agentUrl']) {
        return badRequest('Missing required fields: name, channelConfig, agentUrl');
      }
      const binding = createChannelBinding({
        name: String(body['name']),
        channelType: (body['channelType'] as 'feishu') ?? 'feishu',
        channelConfig: body['channelConfig'] as never,
        accountId: (body['accountId'] as string | undefined) ?? 'default',
        agentUrl: String(body['agentUrl']),
        enabled: (body['enabled'] as boolean | undefined) ?? true,
      });
      // Start the WebSocket monitor for this account
      if (binding.enabled) {
        restartMonitor(binding.accountId).catch((err: unknown) => {
          console.error('[gateway] failed to start monitor:', err);
        });
      }
      return json(binding, 201);
    }

    if ((method === 'PATCH' || method === 'PUT') && channelsPath) {
      const id = channelsPath;
      if (!getChannelBinding(id)) return notFound(`Channel ${id} not found`);
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updated = updateChannelBinding(id, body as never);
      if (!updated) return notFound();
      // Restart monitor if needed
      restartMonitor(updated.accountId).catch((err: unknown) => {
        console.error('[gateway] failed to restart monitor:', err);
      });
      return json(updated);
    }

    if (method === 'DELETE' && channelsPath) {
      const id = channelsPath;
      if (!deleteChannelBinding(id)) return notFound(`Channel ${id} not found`);
      // Re-sync monitors to stop the removed account
      syncMonitors().catch((err: unknown) => {
        console.error('[gateway] failed to sync monitors:', err);
      });
      return json({ deleted: true });
    }

    if (method === 'GET' && channelsPath) {
      const binding = getChannelBinding(channelsPath);
      if (!binding) return notFound();
      return json(binding);
    }
  }

  // ---- Agent configs API ----
  const agentsPath = matchPath(url, '/api/agents');
  if (agentsPath !== null) {
    if (method === 'GET' && agentsPath === '') {
      return json(listAgentConfigs());
    }

    if (method === 'POST' && agentsPath === '') {
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return badRequest('Invalid JSON body');
      }
      if (!body['name'] || !body['url']) {
        return badRequest('Missing required fields: name, url');
      }
      const agent = createAgentConfig({
        name: String(body['name']),
        url: String(body['url']),
        description: body['description'] as string | undefined,
      });
      return json(agent, 201);
    }

    if ((method === 'PATCH' || method === 'PUT') && agentsPath) {
      const id = agentsPath;
      if (!getAgentConfig(id)) return notFound(`Agent ${id} not found`);
      let body: Record<string, unknown>;
      try {
        body = await req.json() as Record<string, unknown>;
      } catch {
        return badRequest('Invalid JSON body');
      }
      const updated = updateAgentConfig(id, body as never);
      if (!updated) return notFound();
      return json(updated);
    }

    if (method === 'DELETE' && agentsPath) {
      const id = agentsPath;
      if (!deleteAgentConfig(id)) return notFound(`Agent ${id} not found`);
      return json({ deleted: true });
    }

    if (method === 'GET' && agentsPath) {
      const agent = getAgentConfig(agentsPath);
      if (!agent) return notFound();
      return json(agent);
    }
  }

  return notFound();
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

console.log(`🚀 A2A Channels Gateway starting on http://localhost:${PORT}`);

const server = Bun.serve({
  port: PORT,
  fetch: handleRequest,
});

console.log(`✅ Gateway listening on http://localhost:${PORT}`);
console.log(`   Web UI:  http://localhost:${PORT}/`);
console.log(`   API:     http://localhost:${PORT}/api/channels`);

// Sync existing monitors on startup
syncMonitors().catch((err: unknown) => {
  console.error('[gateway] initial monitor sync failed:', err);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[gateway] shutting down…');
  await stopAllMonitors();
  server.stop();
  process.exit(0);
});

export default server;
