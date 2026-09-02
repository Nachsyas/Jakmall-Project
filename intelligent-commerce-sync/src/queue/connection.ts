import { Redis } from "ioredis";
import type { ConnectionOptions } from "bullmq";

export class RedisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedisConfigurationError";
  }
}

export function getRedisUrl(): string {
  const envUrl = process.env.REDIS_URL;
  if (!envUrl || envUrl.trim().length === 0) {
    return "redis://localhost:6379";
  }
  return envUrl.trim();
}

export function parseRedisConnectionOptions(redisUrl: string = getRedisUrl()): ConnectionOptions {
  if (!redisUrl || typeof redisUrl !== "string" || redisUrl.trim().length === 0) {
    redisUrl = "redis://localhost:6379";
  }

  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new RedisConfigurationError(`Malformed Redis URL: '${redisUrl}'.`);
  }

  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new RedisConfigurationError(
      `Unsupported Redis protocol '${url.protocol}'. Only 'redis:' and 'rediss:' are supported.`
    );
  }

  const hostname = url.hostname;
  if (!hostname || hostname.trim().length === 0) {
    throw new RedisConfigurationError(`Redis URL '${redisUrl}' is missing a valid hostname.`);
  }

  let port = 6379;
  if (url.port) {
    const parsedPort = parseInt(url.port, 10);
    if (isNaN(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new RedisConfigurationError(`Invalid Redis port '${url.port}' in URL '${redisUrl}'.`);
    }
    port = parsedPort;
  }

  const options: ConnectionOptions = {
    host: hostname,
    port,
    maxRetriesPerRequest: null,
  };

  if (url.protocol === "rediss:") {
    options.tls = {};
  }

  if (url.username) {
    options.username = decodeURIComponent(url.username);
  }
  if (url.password) {
    options.password = decodeURIComponent(url.password);
  }

  return options;
}

export function createRedisConnection(redisUrl: string = getRedisUrl()): Redis {
  parseRedisConnectionOptions(redisUrl);
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
  });
}
