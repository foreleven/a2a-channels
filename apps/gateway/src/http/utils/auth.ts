/**
 * Shared HTTP authentication helpers used by route handlers and WS upgrade
 * handlers across the gateway.
 */

/**
 * Extracts and trims the token value from an `Authorization: Bearer <token>`
 * header.  The input may be `undefined`, a single header string, or an array
 * of header strings (as Node's `IncomingMessage.headers` returns); only the
 * first value is considered.
 */
export function extractBearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match ? (match[1]?.trim() ?? null) : null;
}
