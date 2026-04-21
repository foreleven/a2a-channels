import { Hono, type Context } from "hono";
import { Container } from "inversify";
import {
  AgentNotFoundError,
  DuplicateEnabledBindingError,
  ChannelBindingService,
} from "../../application/channel-binding-service.js";
import type { UpdateChannelBindingData } from "../../application/channel-binding-service.js";

function channelMutationErrorResponse(c: Context, err: unknown) {
  if (err instanceof AgentNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof DuplicateEnabledBindingError) {
    return c.json({ error: err.message }, 409);
  }
  throw err;
}

export function registerChannelRoutes(app: Hono, container: Container): void {
  const channelBindingService = container.get(ChannelBindingService);

  app.get("/api/channels", async (c) => c.json(await channelBindingService.list()));

  app.get("/api/channels/:id", async (c) => {
    const binding = await channelBindingService.getById(c.req.param("id"));
    return binding ? c.json(binding) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/channels", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body["name"] || !body["channelConfig"] || !body["agentId"]) {
      return c.json(
        { error: "Missing required fields: name, channelConfig, agentId" },
        400,
      );
    }
    try {
      const binding = await channelBindingService.create({
        name: String(body["name"]),
        channelType: (body["channelType"] as string | undefined) ?? "feishu",
        channelConfig: body["channelConfig"] as Record<string, unknown>,
        accountId: (body["accountId"] as string | undefined) ?? "default",
        agentId: String(body["agentId"]),
        enabled: (body["enabled"] as boolean | undefined) ?? true,
      });
      return c.json(binding, 201);
    } catch (err) {
      return channelMutationErrorResponse(c, err);
    }
  });

  app.patch("/api/channels/:id", async (c) => {
    const id = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    try {
      const updated = await channelBindingService.update(
        id,
        body as UpdateChannelBindingData,
      );
      if (!updated) return c.json({ error: `Channel ${id} not found` }, 404);
      return c.json(updated);
    } catch (err) {
      return channelMutationErrorResponse(c, err);
    }
  });

  app.delete("/api/channels/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await channelBindingService.delete(id);
    if (!deleted) return c.json({ error: `Channel ${id} not found` }, 404);
    return c.json({ deleted: true });
  });
}
