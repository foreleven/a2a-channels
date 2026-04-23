import { Hono } from "hono";
import { inject, injectable } from "inversify";

import type { UpdateAgentData } from "../../application/agent-service.js";
import {
  AgentService,
  ReferencedAgentError,
} from "../../application/agent-service.js";
import { parseJsonBody } from "../utils/schema.js";
import {
  registerAgentBodySchema,
  updateAgentBodySchema,
} from "../schemas/request-schemas.js";

/**
 * HTTP adapter for agent configuration CRUD.
 *
 * Agent records are plain configuration from the route layer's perspective;
 * reference checks and deletion constraints live in AgentService.
 */
@injectable()
export class AgentRoutes {
  constructor(
    @inject(AgentService)
    private readonly agentService: AgentService,
  ) {}

  register(app: Hono): void {
    app.get("/api/agents", async (c) => c.json(await this.agentService.list()));

    app.get("/api/agents/:id", async (c) => {
      const agent = await this.agentService.getById(c.req.param("id"));
      return agent ? c.json(agent) : c.json({ error: "Not found" }, 404);
    });

    app.post("/api/agents", async (c) => {
      const parsed = await parseJsonBody(c, registerAgentBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      // Default protocol selection is an API concern; deeper routing and
      // transport behavior remains encapsulated behind the runtime layer.
      const agent = await this.agentService.register(parsed.data);
      return c.json(agent, 201);
    });

    app.patch("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      const parsed = await parseJsonBody(c, updateAgentBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      const updated = await this.agentService.update(
        id,
        parsed.data as UpdateAgentData,
      );
      if (!updated) {
        return c.json({ error: `Agent ${id} not found` }, 404);
      }
      return c.json(updated);
    });

    app.delete("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      try {
        const deleted = await this.agentService.delete(id);
        if (!deleted) {
          return c.json({ error: `Agent ${id} not found` }, 404);
        }
        return c.json({ deleted: true });
      } catch (err) {
        // Service-level referential integrity becomes a 409 for the admin UI.
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
}
