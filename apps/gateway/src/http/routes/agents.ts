import { Hono } from "hono";
import { inject, injectable } from "inversify";

import {
  AgentService,
  InvalidAgentConfigError,
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

      try {
        // Default protocol selection is an API concern; deeper routing and
        // transport behavior remains encapsulated behind the runtime layer.
        const agent = await this.agentService.register(parsed.data);
        return c.json(agent, 201);
      } catch (err) {
        if (err instanceof InvalidAgentConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.patch("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      const parsed = await parseJsonBody(c, updateAgentBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        const updated = await this.agentService.update(id, parsed.data);
        if (!updated) {
          return c.json({ error: `Agent ${id} not found` }, 404);
        }
        return c.json(updated);
      } catch (err) {
        if (err instanceof InvalidAgentConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
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
