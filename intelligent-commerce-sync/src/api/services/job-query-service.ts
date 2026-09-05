import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../persistence/prisma.js";
import type { JobItemDto, JobListResponse } from "../types.js";

export class JobQueryService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async listJobs(options: { limit?: number | undefined } = {}): Promise<JobListResponse> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));

    const jobs = await this.prisma.syncJob.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        productSource: {
          select: {
            sourceProductId: true,
            sourceUrl: true,
          },
        },
      },
    });

    const mapped: JobItemDto[] = jobs.map((job) => ({
      id: job.id,
      productSourceId: job.productSourceId,
      sourceProductId: job.productSource?.sourceProductId ?? null,
      sourceUrl: job.productSource?.sourceUrl ?? null,
      operation: job.operationType,
      jobType: job.jobType,
      status: job.status,
      attemptCount: job.attemptCount,
      error: job.lastErrorMessage
        ? {
            code: job.lastErrorCode ?? "EXECUTION_ERROR",
            message: job.lastErrorMessage,
          }
        : null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    }));

    return {
      total: mapped.length,
      jobs: mapped,
    };
  }
}
