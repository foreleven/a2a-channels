import { Hono, type Context } from "hono";
import { inject, injectable } from "inversify";

import {
  AgentNotFoundError,
  ChannelBindingService,
  DuplicateEnabledBindingError,
} from "../../application/channel-binding-service.js";
import type { UpdateChannelBindingData } from "../../application/channel-binding-service.js";
import { parseJsonBody } from "../utils/schema.js";
import {
  createChannelBindingBodySchema,
  updateChannelBindingBodySchema,
} from "../schemas/request-schemas.js";

/**
 * Maps application-layer channel binding errors onto HTTP responses.
 *
 * The route layer should translate transport concerns only; domain/application
 * exceptions remain owned by the service layer.
 */
function channelMutationErrorResponse(c: Context, err: unknown) {
  if (err instanceof AgentNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof DuplicateEnabledBindingError) {
    return c.json({ error: err.message }, 409);
  }
  throw err;
}

/**
 * HTTP adapter for channel binding management.
 *
 * Responsibilities are intentionally thin:
 * - parse/validate the request envelope
 * - invoke the application service
 * - translate application outcomes into HTTP status codes
 *
 * It should not own monitor/runtime orchestration rules directly.
 */
@injectable()
export class ChannelRoutes {
  constructor(
    @inject(ChannelBindingService)
    private readonly channelBindingService: ChannelBindingService,
  ) {}

  register(app: Hono): void {
    app.get("/api/channels", async (c) =>
      c.json(await this.channelBindingService.list()),
    );

    app.get("/api/channels/:id", async (c) => {
      const binding = await this.channelBindingService.getById(
        c.req.param("id"),
      );
      return binding ? c.json(binding) : c.json({ error: "Not found" }, 404);
    });

    app.post("/api/channels", async (c) => {
      const parsed = await parseJsonBody(c, createChannelBindingBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        const binding = await this.channelBindingService.create(parsed.data);
        return c.json(binding, 201);
      } catch (err) {
        return channelMutationErrorResponse(c, err);
      }
    });

    app.patch("/api/channels/:id", async (c) => {
      const id = c.req.param("id");
      const parsed = await parseJsonBody(c, updateChannelBindingBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        // PATCH forwards a sparse payload directly to the application service;
        // field-level semantics live there rather than in the HTTP adapter.
        const updated = await this.channelBindingService.update(
          id,
          parsed.data as UpdateChannelBindingData,
        );
        if (!updated) {
          return c.json({ error: `Channel ${id} not found` }, 404);
        }
        return c.json(updated);
      } catch (err) {
        return channelMutationErrorResponse(c, err);
      }
    });

    app.delete("/api/channels/:id", async (c) => {
      const id = c.req.param("id");
      const deleted = await this.channelBindingService.delete(id);
      if (!deleted) {
        return c.json({ error: `Channel ${id} not found` }, 404);
      }
      return c.json({ deleted: true });
    });
  }
}
