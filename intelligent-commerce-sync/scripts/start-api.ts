import { createApiServer } from "../src/api/server.js";
import { disconnectPrismaClient } from "../src/persistence/prisma.js";

const PORT = parseInt(process.env["PORT"] ?? "3001", 10);
const HOST = process.env["HOST"] ?? "localhost";

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

const allowedOrigins = parseAllowedOrigins(process.env["CORS_ALLOWED_ORIGINS"]);

const server = createApiServer({
  corsOptions: allowedOrigins ? { allowedOrigins } : undefined,
});

server.listen(PORT, HOST, () => {
  console.log("==================================================");
  console.log("       Intelligent Commerce Sync — API Server      ");
  console.log("==================================================");
  console.log(`API running at: http://${HOST}:${PORT}`);
  console.log(`Health check  : http://${HOST}:${PORT}/api/health`);
  console.log(`Products API  : http://${HOST}:${PORT}/api/products`);
  console.log(`Catalog API   : http://${HOST}:${PORT}/api/catalog/discover`);
  console.log(`Shopee Prepare: http://${HOST}:${PORT}/api/products/:id/prepare-shopee`);
  console.log(`Reviews API   : http://${HOST}:${PORT}/api/reviews`);
  console.log(`Jobs API      : http://${HOST}:${PORT}/api/jobs`);
  console.log("==================================================");
});

async function shutdown() {
  console.log("\nShutting down API server gracefully...");
  server.close(async () => {
    await disconnectPrismaClient();
    console.log("API server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
