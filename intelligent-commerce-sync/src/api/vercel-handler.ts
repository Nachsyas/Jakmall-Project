import type { IncomingMessage, ServerResponse } from "node:http";
import { createApiRequestListener, type ApiServerDeps } from "./server.js";

function parseAllowedOrigins(raw?: string): string[] | undefined {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
  return origins.length > 0 ? origins : undefined;
}

export function createVercelHandler(deps: ApiServerDeps = {}) {
  const allowedOrigins =
    deps.corsOptions?.allowedOrigins ?? parseAllowedOrigins(process.env["CORS_ALLOWED_ORIGINS"]);
  const listener = createApiRequestListener({
    ...deps,
    corsOptions: allowedOrigins ? { allowedOrigins } : deps.corsOptions,
  });

  return async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url && !req.url.startsWith("/api")) {
      req.url = `/api${req.url.startsWith("/") ? "" : "/"}${req.url}`;
    }
    await listener(req, res);
  };
}

const defaultHandler = createVercelHandler();

export default defaultHandler;
