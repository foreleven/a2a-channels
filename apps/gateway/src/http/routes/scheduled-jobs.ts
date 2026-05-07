import { Hono } from "hono";
import { inject, injectable } from "inversify";

import { Prisma } from "../../generated/prisma/index.js";
import { ScheduledJobService } from "../../application/scheduled-job-service.js";
import { parseJsonBody } from "../utils/schema.js";
import {
  createScheduledJobBodySchema,
  updateScheduledJobBodySchema,
} from "../schemas/request-schemas.js";

/** HTTP adapter for scheduled job definition CRUD. */
@injectable()
export class ScheduledJobRoutes {
  constructor(
    @inject(ScheduledJobService)
    private readonly jobs: ScheduledJobService,
  ) {}

  register(app: Hono): void {
    app.get("/api/scheduled-jobs", async (c) =>
      c.json(await this.jobs.list()),
    );

    app.get("/api/scheduled-jobs/:id", async (c) => {
      const job = await this.jobs.getById(c.req.param("id"));
      return job ? c.json(job) : c.json({ error: "Not found" }, 404);
    });

    app.post("/api/scheduled-jobs", async (c) => {
      const parsed = await parseJsonBody(c, createScheduledJobBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const job = await this.jobs.create(parsed.data);
        return c.json(job, 201);
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2003"
        ) {
          return c.json({ error: "Referenced channel binding not found" }, 422);
        }
        throw err;
      }
    });

    app.patch("/api/scheduled-jobs/:id", async (c) => {
      const id = c.req.param("id");
      const parsed = await parseJsonBody(c, updateScheduledJobBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }
      const updated = await this.jobs.update(id, parsed.data);
      if (!updated) {
        return c.json({ error: `Scheduled job ${id} not found` }, 404);
      }
      return c.json(updated);
    });

    app.delete("/api/scheduled-jobs/:id", async (c) => {
      const id = c.req.param("id");
      const deleted = await this.jobs.delete(id);
      if (!deleted) {
        return c.json({ error: `Scheduled job ${id} not found` }, 404);
      }
      return c.json({ deleted: true });
    });
  }
}
