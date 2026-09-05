import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import { getPrismaClient } from "../src/persistence/prisma.js";

interface HealthResponse {
  status: string;
  timestamp: string;
  services: {
    database: string;
    redis: string;
  };
}

before(async () => {
  // Ensure one-time client initialization / dotenv loading occurs before test suites
  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
  } catch {
    // ignore
  }
});

async function withTestServer(
  checkRedisHealth: ((redisUrl?: string) => Promise<boolean>) | undefined,
  testFn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createApiServer({ checkRedisHealth });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await testFn(baseUrl);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

test("1. Redis unconfigured: returns redis unconfigured when REDIS_URL is absent", async () => {
  const originalRedisUrl = process.env["REDIS_URL"];
  delete process.env["REDIS_URL"];
  try {
    let checkCalls = 0;
    await withTestServer(
      async () => {
        checkCalls++;
        return true;
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as HealthResponse;
        assert.equal(data.status, "ok");
        assert.equal(typeof data.timestamp, "string");
        assert.equal(typeof data.services, "object");
        assert.ok(["connected", "disconnected", "unconfigured"].includes(data.services.database));
        assert.equal(data.services.redis, "unconfigured");
        assert.equal(checkCalls, 0, "checkRedisHealth must not be called when REDIS_URL is absent");
      }
    );
  } finally {
    if (originalRedisUrl !== undefined) {
      process.env["REDIS_URL"] = originalRedisUrl;
    } else {
      delete process.env["REDIS_URL"];
    }
  }
});

test("2. Redis healthy: returns redis connected when Redis health dependency returns true", async () => {
  const originalRedisUrl = process.env["REDIS_URL"];
  const dummyRedisUrl = "redis://127.0.0.1:6379";
  process.env["REDIS_URL"] = dummyRedisUrl;
  try {
    let capturedUrl: string | undefined;
    await withTestServer(
      async (url) => {
        capturedUrl = url;
        return true;
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as HealthResponse;
        assert.equal(data.status, "ok");
        assert.equal(typeof data.timestamp, "string");
        assert.equal(typeof data.services, "object");
        assert.ok(["connected", "disconnected", "unconfigured"].includes(data.services.database));
        assert.equal(data.services.redis, "connected");
        assert.equal(capturedUrl, dummyRedisUrl);
      }
    );
  } finally {
    if (originalRedisUrl !== undefined) {
      process.env["REDIS_URL"] = originalRedisUrl;
    } else {
      delete process.env["REDIS_URL"];
    }
  }
});

test("3. Redis unhealthy: returns redis disconnected when Redis health dependency returns false", async () => {
  const originalRedisUrl = process.env["REDIS_URL"];
  const dummyRedisUrl = "redis://127.0.0.1:6379";
  process.env["REDIS_URL"] = dummyRedisUrl;
  try {
    let capturedUrl: string | undefined;
    await withTestServer(
      async (url) => {
        capturedUrl = url;
        return false;
      },
      async (baseUrl) => {
        const res = await fetch(`${baseUrl}/api/health`);
        assert.equal(res.status, 200);
        const data = (await res.json()) as HealthResponse;
        assert.equal(data.status, "ok");
        assert.equal(typeof data.timestamp, "string");
        assert.equal(typeof data.services, "object");
        assert.ok(["connected", "disconnected", "unconfigured"].includes(data.services.database));
        assert.equal(data.services.redis, "disconnected");
        assert.equal(capturedUrl, dummyRedisUrl);
      }
    );
  } finally {
    if (originalRedisUrl !== undefined) {
      process.env["REDIS_URL"] = originalRedisUrl;
    } else {
      delete process.env["REDIS_URL"];
    }
  }
});
