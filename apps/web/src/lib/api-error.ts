/**
 * Extracts a human-readable error message from a caught API error.
 *
 * Gateway error responses are JSON objects with an `error` string field.
 * The fetch helpers in api.ts propagate them as `Error` objects whose
 * `message` is the raw response body text. This function attempts to
 * parse that body as JSON and return `error`, falling back to the raw
 * string when parsing fails.
 */
export function extractApiErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const text = err.message;

  // Attempt to parse the body as a JSON object with an `error` field.
  // The body may optionally be prefixed with "Error: " by some runtimes.
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(text.slice(jsonStart)) as unknown;
      if (
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as Record<string, unknown>)["error"] === "string"
      ) {
        return (body as Record<string, string>)["error"];
      }
    } catch {
      // fall through to raw message
    }
  }

  return text;
}
