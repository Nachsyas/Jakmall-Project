import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

export interface CorsOptions {
  allowedOrigins?: string[] | undefined;
}

/**
 * Applies conservative CORS headers for local web application development.
 * Never uses wildcard '*' for requests with origin headers.
 * Returns true if request was an OPTIONS preflight and was handled, false otherwise.
 */
export function handleCors(
  req: IncomingMessage,
  res: ServerResponse,
  options: CorsOptions = {}
): boolean {
  const origin = req.headers["origin"];
  const allowedOrigins = options.allowedOrigins
    ? new Set(options.allowedOrigins.filter((o) => o !== "*"))
    : DEFAULT_ALLOWED_ORIGINS;

  if (typeof origin === "string" && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return true;
  }

  return false;
}
