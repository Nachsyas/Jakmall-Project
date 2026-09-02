import { PrismaClient } from "@prisma/client";

let prismaInstance: PrismaClient | null = null;

/**
 * Returns the singleton PrismaClient instance for the application.
 * Does not perform automatic network connection at import time.
 * Prisma connects lazily upon the first database query or explicit $connect().
 */
export function getPrismaClient(): PrismaClient {
  if (!prismaInstance) {
    prismaInstance = new PrismaClient({
      log: process.env["NODE_ENV"] === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return prismaInstance;
}

/**
 * Explicitly disconnects and clears the singleton PrismaClient instance.
 * Safe to call during graceful application shutdown or test teardown.
 */
export async function disconnectPrismaClient(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect();
    prismaInstance = null;
  }
}

/**
 * Injects a custom or mock PrismaClient instance (e.g. for unit testing).
 */
export function setPrismaClient(client: PrismaClient | null): void {
  prismaInstance = client;
}
