import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "../../persistence/prisma.js";
import type { ReviewItemDto, ReviewListResponse } from "../types.js";

export class ReviewQueryService {
  private readonly prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async listReviews(options: { limit?: number | undefined } = {}): Promise<ReviewListResponse> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));

    // Find jobs requiring operator review or blocked
    const reviewJobs = await this.prisma.syncJob.findMany({
      where: {
        status: {
          in: ["NEEDS_REVIEW", "BLOCKED"],
        },
      },
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        productSource: true,
      },
    });

    const reviews: ReviewItemDto[] = reviewJobs.map((job) => {
      const reason =
        job.lastErrorMessage ||
        job.lastErrorCode ||
        (job.status === "NEEDS_REVIEW"
          ? "Sync operation requires operator review"
          : "Sync operation is blocked by validation policy");

      return {
        id: job.id,
        productId: job.productSource?.productId ?? null,
        sourceProductId: job.productSource?.sourceProductId ?? null,
        sourceUrl: job.productSource?.sourceUrl ?? null,
        operation: job.operationType,
        status: job.status,
        reason,
        createdAt: job.createdAt.toISOString(),
        updatedAt: job.updatedAt.toISOString(),
      };
    });

    return {
      total: reviews.length,
      reviews,
    };
  }
}
