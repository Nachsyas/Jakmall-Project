import { Redis } from "ioredis";
import { parseRedisConnectionOptions, getRedisUrl } from "./connection.js";

export async function checkRedisHealth(redisUrl: string = getRedisUrl()): Promise<boolean> {
  let client: Redis | null = null;
  try {
    parseRedisConnectionOptions(redisUrl);
    client = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: 3000,
    });
    await client.connect();
    const pong = await client.ping();
    return pong === "PONG";
  } catch {
    return false;
  } finally {
    if (client) {
      try {
        client.disconnect();
      } catch {
        // ignore teardown errors
      }
    }
  }
}
