import type { Context } from "hono";
import { z, type ZodType } from "zod";

export interface RequestValidationIssue {
  path: string;
  message: string;
}

export interface RequestValidationErrorBody {
  error: "Invalid request body";
  issues: RequestValidationIssue[];
}

/**
 * Parses JSON request bodies through a schema owned by the HTTP layer.
 *
 * This keeps body parsing, type coercion/defaulting, and validation errors
 * consistent across route handlers without leaking schema concerns downward.
 */
export async function parseJsonBody<T>(
  c: Context,
  schema: ZodType<T>,
): Promise<
  { success: true; data: T } | { success: false; response: Response }
> {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return {
      success: false,
      response: c.json({ error: "Invalid JSON body" }, 400),
    };
  }

  const parsed = schema.safeParse(body);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }

  const issues: RequestValidationIssue[] = parsed.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));

  return {
    success: false,
    response: c.json<RequestValidationErrorBody>(
      {
        error: "Invalid request body",
        issues,
      },
      400,
    ),
  };
}

export { z };
