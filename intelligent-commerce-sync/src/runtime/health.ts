import type { PrismaClient } from "@prisma/client";
import type { SyncExecutionQueue } from "../queue/sync-queue.js";
import { checkRedisHealth } from "../queue/health.js";
import { getRedisUrl } from "../queue/connection.js";
import { resolveRuntimeConfig, validateRuntimeConfig } from "./config.js";
import type {
  RuntimeConfig,
  RuntimeClock,
  RuntimeHealthSnapshot,
  RuntimeHealthStatus,
} from "./types.js";

export interface HealthProbeOverrides {
  checkDatabase?: (() => Promise<boolean>) | undefined;
  checkRedis?: (() => Promise<boolean>) | undefined;
  checkQueue?: (() => Promise<{
    healthy: boolean;
    counts?: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      completed: number;
    } | undefined;
  }>) | undefined;
  checkSyncJobsMetrics?: (() => Promise<{
    pending: number;
    processing: number;
    failed: number;
    needsReview: number;
    blocked: number;
    staleProcessing: number;
  } | null>) | undefined;
}

export interface RuntimeHealthServiceOptions {
  config?: RuntimeConfig | undefined;
  clock?: RuntimeClock | undefined;
  redisUrl?: string | undefined;
  probes?: HealthProbeOverrides | undefined;
}

export class RuntimeHealthService {
  private readonly config: RuntimeConfig;
  private readonly clock: RuntimeClock;
  private readonly redisUrl: string;
  private readonly probes: HealthProbeOverrides | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly syncQueue: SyncExecutionQueue,
    options?: RuntimeHealthServiceOptions
  ) {
    this.config = options?.config !== undefined ? validateRuntimeConfig(options.config) : resolveRuntimeConfig();
    this.clock = options?.clock ?? (() => new Date());
    this.redisUrl = options?.redisUrl ?? getRedisUrl();
    this.probes = options?.probes;
  }

  async getHealthSnapshot(): Promise<RuntimeHealthSnapshot> {
    const now = this.clock();

    // 1. Probe Database Health (safe SELECT 1 tagged template)
    let dbHealthy = false;
    try {
      if (this.probes?.checkDatabase) {
        dbHealthy = await this.probes.checkDatabase();
      } else {
        await this.prisma.$queryRaw`SELECT 1`;
        dbHealthy = true;
      }
    } catch {
      dbHealthy = false;
    }

    // 2. Probe Redis Health (reusing certified checkRedisHealth)
    let redisHealthy = false;
    try {
      if (this.probes?.checkRedis) {
        redisHealthy = await this.probes.checkRedis();
      } else {
        redisHealthy = await checkRedisHealth(this.redisUrl);
      }
    } catch {
      redisHealthy = false;
    }

    // 3. Probe BullMQ Queue Health
    let queueHealthy = false;
    let queueCounts:
      | {
          waiting: number;
          active: number;
          delayed: number;
          failed: number;
          completed: number;
        }
      | undefined = undefined;

    try {
      if (this.probes?.checkQueue) {
        const res = await this.probes.checkQueue();
        queueHealthy = res.healthy;
        queueCounts = res.counts;
      } else {
        const rawCounts = await this.syncQueue.getJobCounts();
        queueHealthy = true;
        queueCounts = {
          waiting: rawCounts.waiting ?? 0,
          active: rawCounts.active ?? 0,
          delayed: rawCounts.delayed ?? 0,
          failed: rawCounts.failed ?? 0,
          completed: rawCounts.completed ?? 0,
        };
      }
    } catch {
      queueHealthy = false;
    }

    // 4. Inspect SyncJob Operational Metrics (only if DB probe succeeded)
    let syncJobsMetrics: RuntimeHealthSnapshot["syncJobs"] = undefined;
    let metricsHealthy = false;
    let staleCount = 0;

    if (dbHealthy) {
      try {
        if (this.probes?.checkSyncJobsMetrics) {
          const probeRes = await this.probes.checkSyncJobsMetrics();
          if (probeRes) {
            syncJobsMetrics = probeRes;
            staleCount = probeRes.staleProcessing;
            metricsHealthy = true;
          } else {
            metricsHealthy = false;
          }
        } else {
          const counts = await this.prisma.syncJob.groupBy({
            by: ["status"],
            _count: { id: true },
          });

          const statusMap = new Map<string, number>();
          for (const c of counts) {
            statusMap.set(c.status, c._count.id);
          }

          const cutoff = new Date(now.getTime() - this.config.staleProcessingMs);
          staleCount = await this.prisma.syncJob.count({
            where: {
              status: "PROCESSING",
              updatedAt: { lte: cutoff },
            },
          });

          syncJobsMetrics = {
            pending: statusMap.get("PENDING") ?? 0,
            processing: statusMap.get("PROCESSING") ?? 0,
            failed: statusMap.get("FAILED") ?? 0,
            needsReview: statusMap.get("NEEDS_REVIEW") ?? 0,
            blocked: statusMap.get("BLOCKED") ?? 0,
            staleProcessing: staleCount,
          };
          metricsHealthy = true;
        }
      } catch {
        // Operational metrics could not be loaded -> fail closed
        metricsHealthy = false;
      }
    }

    // 5. Determine Aggregated Health Status
    // Fail closed: if DB, Redis, Queue, or SyncJob operational metrics inspection failed, status is UNHEALTHY.
    let status: RuntimeHealthStatus;
    if (!dbHealthy || !redisHealthy || !queueHealthy || !metricsHealthy) {
      status = "UNHEALTHY";
    } else if (staleCount > 0) {
      status = "DEGRADED";
    } else {
      status = "HEALTHY";
    }

    return {
      status,
      checkedAt: now.toISOString(),
      database: {
        healthy: dbHealthy,
      },
      redis: {
        healthy: redisHealthy,
      },
      queue: {
        healthy: queueHealthy,
        ...(queueCounts ? { counts: queueCounts } : {}),
      },
      ...(syncJobsMetrics ? { syncJobs: syncJobsMetrics } : {}),
    };
  }
}
