import { Hono } from "hono";
import { Container } from "inversify";

import { SERVICE_TOKENS } from "@a2a-channels/di";

import type { AgentService, UpdateAgentData } from "../../application/agent-service.js";
import { ReferencedAgentError } from "../../application/agent-service.js";

export function registerAgentRoutes(app: Hono, container: Container): void {
  const agentService = container.get<AgentService>(SERVICE_TOKENS.AgentService);

  app.get("/api/agents", async (c) => c.json(await agentService.list()));

  app.get("/api/agents/:id", async (c) => {
    const agent = await agentService.getById(c.req.param("id"));
    return agent ? c.json(agent) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/agents", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body["name"] || !body["url"]) {
      return c.json({ error: "Missing required fields: name, url" }, 400);
    }
    const agent = await agentService.register({
      name: String(body["name"]),
      url: String(body["url"]),
      protocol: (body["protocol"] as string | undefined) ?? "a2a",
      description: body["description"] as string | undefined,
    });
    return c.json(agent, 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const updated = await agentService.update(id, body as UpdateAgentData);
    if (!updated) return c.json({ error: `Agent ${id} not found` }, 404);
    return c.json(updated);
  });

  app.delete("/api/agents/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const deleted = await agentService.delete(id);
      if (!deleted) return c.json({ error: `Agent ${id} not found` }, 404);
      return c.json({ deleted: true });
    } catch (err) {
      if (err instanceof ReferencedAgentError) {
        return c.json(
          { error: err.message, bindingIds: err.bindingIds },
          409,
        );
      }
      throw err;
    }
  });
}
