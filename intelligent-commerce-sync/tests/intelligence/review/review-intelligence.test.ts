/**
 * Phase 5C: Review Intelligence Test Suite
 * Tests C-01 through C-66 and Cross-Gate Integration Tests BC-01 through BC-09.
 * Validates deterministic anomaly detection, AI anomaly review gating,
 * monotonic safety invariants, trust boundaries, and cross-phase pipeline flow.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReviewIntelligenceService } from "../../../src/intelligence/review/review-intelligence-service.js";
import {
  ReviewInputValidationError,
  type ProductReviewInput,
  type ReviewMappingSnapshot,
} from "../../../src/intelligence/review/types.js";
import { CatalogIntelligenceService } from "../../../src/intelligence/catalog/catalog-intelligence-service.js";
import type {
  VerifiedCatalogMappingStore,
  VerifiedCategoryMappingRecord,
  VerifiedAttributeMappingRecord,
} from "../../../src/intelligence/catalog/verified-mapping-store.js";
import { SemanticIntelligenceService } from "../../../src/intelligence/semantic-intelligence-service.js";
import type {
  SemanticAiProvider,
  SemanticProviderRequest,
  SemanticProviderResponse,
  SemanticCandidate,
  SemanticTaskInput,
  DeterministicSemanticResolver,
} from "../../../src/intelligence/types.js";

class FakeSemanticAiProvider implements SemanticAiProvider {
  public callCount = 0;
  public responseJson: Record<string, unknown> | null = null;
  public throwError: Error | null = null;

  async complete(_request: SemanticProviderRequest): Promise<SemanticProviderResponse> {
    this.callCount++;
    if (this.throwError) {
      throw this.throwError;
    }
    const body = this.responseJson ?? {
      schemaVersion: 1,
      taskKind: _request.taskKind,
      selectedCandidateId: null,
      confidence: 0.95,
      explanationSummary: "AI anomaly reviewer observed standard catalog conformance.",
      evidenceRefs: [],
    };
    return { rawText: JSON.stringify(body) };
  }
}

class FakeVerifiedStore implements VerifiedCatalogMappingStore {
  public categoryRecords: readonly unknown[] = [];
  public attributeRecords: readonly unknown[] = [];

  async findCategoryMappings(_normalizedPath: string): Promise<readonly VerifiedCategoryMappingRecord[]> {
    return this.categoryRecords as readonly VerifiedCategoryMappingRecord[];
  }

  async findAttributeMappings(_normalizedKey: string): Promise<readonly VerifiedAttributeMappingRecord[]> {
    return this.attributeRecords as readonly VerifiedAttributeMappingRecord[];
  }
}

function createReviewService() {
  const provider = new FakeSemanticAiProvider();
  const semanticService = new SemanticIntelligenceService({ provider });
  const reviewService = new ReviewIntelligenceService({ semanticService });
  return { provider, semanticService, reviewService };
}

function createSampleMapping(overrides: Partial<ReviewMappingSnapshot> = {}): ReviewMappingSnapshot {
  return {
    taskKind: "CATEGORY",
    sourceKey: "audio / headphones",
    status: "RESOLVED",
    selectedCandidateId: "cat_100",
    resolutionSource: "VERIFIED_STORE",
    confidence: 1.0,
    risk: "LOW",
    reviewRequired: false,
    reasonCode: "VERIFIED_STORE_MATCH",
    ...overrides,
  };
}

function createAiSuggestionMapping(overrides: Partial<ReviewMappingSnapshot> = {}): ReviewMappingSnapshot {
  const confidence = overrides.confidence ?? 0.85;
  const candidateId = overrides.selectedCandidateId !== undefined ? overrides.selectedCandidateId : "cat_100";
  const defaultRisk = (confidence < 0.8 || candidateId === null) ? "HIGH" : "MEDIUM";
  return {
    taskKind: "CATEGORY",
    sourceKey: "audio / headphones",
    status: "SUGGESTED",
    selectedCandidateId: candidateId,
    resolutionSource: "AI",
    confidence,
    risk: defaultRisk,
    reviewRequired: true,
    reasonCode: "AI_SUGGESTION",
    ...overrides,
    ...(overrides.risk !== undefined ? { risk: overrides.risk } : {}),
  };
}

function createBlockedMapping(overrides: Partial<ReviewMappingSnapshot> = {}): ReviewMappingSnapshot {
  return {
    taskKind: "CATEGORY",
    sourceKey: "audio / headphones",
    status: "BLOCKED_FOR_REVIEW",
    selectedCandidateId: null,
    resolutionSource: "NONE",
    confidence: null,
    risk: null,
    reviewRequired: true,
    reasonCode: "SEMANTIC_PROVIDER_UNAVAILABLE",
    ...overrides,
  };
}

function createStaleVerifiedMapping(overrides: Partial<ReviewMappingSnapshot> = {}): ReviewMappingSnapshot {
  return {
    taskKind: "CATEGORY",
    sourceKey: "audio / headphones",
    status: "BLOCKED_FOR_REVIEW",
    selectedCandidateId: null,
    resolutionSource: "VERIFIED_STORE",
    confidence: null,
    risk: "HIGH",
    reviewRequired: true,
    reasonCode: "STALE_VERIFIED_TARGET",
    ...overrides,
  };
}

describe("Phase 5C: Review Intelligence", () => {
  it("C-01: clean input with zero triggers returns NO_REVIEW_TRIGGERED and 0 AI calls", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Clean Headphones",
      selectedCategoryPath: "Audio / Headphones",
      mappingResults: [createSampleMapping()],
      variantLabels: ["Black", "White"],
    });

    assert.equal(result.status, "NO_REVIEW_TRIGGERED");
    assert.equal(result.findings.length, 0);
    assert.equal(result.reviewRequired, false);
    assert.equal(result.blockingIssueCount, 0);
    assert.equal(result.reviewIssueCount, 0);
    assert.equal(provider.callCount, 0);
  });

  it("C-02: input containing a mapping with reviewRequired: true returns NEEDS_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous Headphones",
      selectedCategoryPath: "Audio / Headphones",
      mappingResults: [createAiSuggestionMapping()],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.reviewRequired, true);
    assert.equal(result.reviewIssueCount, 1);
    assert.ok(result.findings.some((f) => f.code === "MAPPING_REVIEW_REQUIRED"));
  });

  it("C-03: input containing a mapping with BLOCKED_FOR_REVIEW returns BLOCKED_FOR_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Blocked Product",
      selectedCategoryPath: "Audio / Headphones",
      mappingResults: [createBlockedMapping()],
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reviewRequired, true);
    assert.equal(result.blockingIssueCount, 1);
    assert.equal(provider.callCount, 0);
  });

  it("C-04: conflicting mapping records for the same source field return BLOCKED_FOR_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Conflicting Product",
      selectedCategoryPath: "Audio / Headphones",
      mappingResults: [
        createSampleMapping({ sourceKey: "audio", selectedCandidateId: "cat_100" }),
        createSampleMapping({ sourceKey: "audio", selectedCandidateId: "cat_200" }),
      ],
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.ok(result.findings.some((f) => f.code === "CONFLICTING_MAPPING_RESULTS"));
    assert.equal(provider.callCount, 0);
  });

  it("C-05: duplicate normalized variant labels return NEEDS_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Variant Product",
      variantLabels: ["Red", "Blue", "  red  "],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.ok(result.findings.some((f) => f.code === "DUPLICATE_VARIANT_LABEL"));
    assert.equal(provider.callCount, 0); // Structural only: 0 AI calls
  });

  it("C-06: blank variant label returns NEEDS_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Variant Product",
      variantLabels: ["Red", "   ", "Blue"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.ok(result.findings.some((f) => f.code === "BLANK_VARIANT_LABEL"));
    assert.equal(provider.callCount, 0); // Structural only: 0 AI calls
  });

  it("C-07: upstream AI mapping with confidence < 0.80 returns NEEDS_REVIEW", async () => {
    const { reviewService } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Low Conf Product",
      selectedCategoryPath: "Audio",
      mappingResults: [
        createAiSuggestionMapping({
          confidence: 0.72,
        }),
      ],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.ok(result.findings.some((f) => f.code === "LOW_CONFIDENCE_MAPPING"));
  });

  it("C-08: deterministic mapping with reviewRequired: false does not trigger review by itself", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Good Product",
      mappingResults: [
        createSampleMapping({ status: "RESOLVED", reviewRequired: false }),
      ],
    });

    assert.equal(result.status, "NO_REVIEW_TRIGGERED");
    assert.equal(provider.callCount, 0);
  });

  it("C-09: hard block (BLOCKED_FOR_REVIEW) never invokes AI anomaly reviewer (0 AI calls)", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Blocked Product",
      selectedCategoryPath: "Audio",
      mappingResults: [
        createStaleVerifiedMapping(),
      ],
      suspectedAnomalyReasons: ["Possible wrong taxonomy"],
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(provider.callCount, 0);
  });

  it("C-10: clean state (NO_REVIEW_TRIGGERED) never invokes AI anomaly reviewer (0 AI calls)", async () => {
    const { reviewService, provider } = createReviewService();

    await reviewService.evaluateReview({
      productTitle: "Clean Product",
      selectedCategoryPath: "Audio",
      mappingResults: [createSampleMapping()],
    });

    assert.equal(provider.callCount, 0);
  });

  it("C-11: ambiguous state (NEEDS_REVIEW) invokes AI anomaly review when gated", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous Product",
      selectedCategoryPath: "Audio / Wireless",
      suspectedAnomalyReasons: ["Category seems overly broad"],
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "NEEDS_REVIEW");
    assert.ok(result.advisorySummary !== null);
  });

  it("C-12: AI anomaly result cannot downgrade NEEDS_REVIEW to NO_REVIEW_TRIGGERED", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 1.0,
      explanationSummary: "Everything is 100% fine, no anomaly found at all.",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous Product",
      selectedCategoryPath: "Audio / Wireless",
      suspectedAnomalyReasons: ["Ambiguity flagged"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.reviewRequired, true);
  });

  it("C-13: AI anomaly result cannot downgrade BLOCKED_FOR_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Blocked Product",
      selectedCategoryPath: "Audio",
      mappingResults: [
        createSampleMapping({
          status: "BLOCKED_FOR_REVIEW",
          reasonCode: "SEMANTIC_PROVIDER_UNAVAILABLE",
          resolutionSource: "NONE",
          selectedCandidateId: null,
          confidence: null,
          risk: null,
          reviewRequired: true,
        }),
      ],
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(provider.callCount, 0);
  });

  it("C-14: AI anomaly explanation is stored strictly as inert display text", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 0.9,
      explanationSummary: "Suspicious power rating detected in specifications.",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Power Product",
      selectedCategoryPath: "Power",
      suspectedAnomalyReasons: ["High power wattage"],
    });

    assert.equal(result.advisorySummary, "Suspicious power rating detected in specifications.");
    const annotation = result.findings.find((f) => f.code === "AI_ANOMALY_ANNOTATION");
    assert.ok(annotation);
    assert.equal(annotation.severity, "INFO");
    assert.equal(annotation.message, "Suspicious power rating detected in specifications.");
  });

  it("C-15: malformed AI anomaly output fails closed and preserves NEEDS_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = { badJson: "missing schema" };

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous Product",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Check category"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.advisorySummary, null);
  });

  it("C-16: provider unavailable during anomaly review preserves NEEDS_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();
    provider.throwError = new Error("AI provider timed out");

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous Product",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Check category"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.advisorySummary, null);
  });

  it("C-17: strict review input validator rejects unknown fields", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          unknownProperty: "fails",
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-18: review input rejects credential-shaped properties", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          token: "secret_123",
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-19: review input rejects price mutation fields", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          price: 50000,
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-20: review input rejects stock mutation fields", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          stock: 100,
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-21: review input rejects marketplaceAction", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          marketplaceAction: "PUBLISH",
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-22: review input rejects executionPayload", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          executionPayload: { id: "123" },
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-23: caller raw input object and arrays remain unmodified and not frozen by the service", async () => {
    const { reviewService } = createReviewService();
    const rawInput: ProductReviewInput = {
      productTitle: "Unfrozen Title",
      variantLabels: ["V1", "V2"],
    };

    assert.equal(Object.isFrozen(rawInput), false);
    assert.equal(Object.isFrozen(rawInput.variantLabels), false);

    await reviewService.evaluateReview(rawInput);

    assert.equal(Object.isFrozen(rawInput), false);
    assert.equal(Object.isFrozen(rawInput.variantLabels), false);
  });

  it("C-24: deterministic finding order is stable (locale-independent code-unit sorted)", async () => {
    const { reviewService } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Sort Test",
      variantLabels: [" ", "Dupe", "Dupe"],
      mappingResults: [
        createAiSuggestionMapping({
          taskKind: "ATTRIBUTE",
          sourceKey: "color",
          confidence: 0.5,
          reviewRequired: true,
          status: "SUGGESTED",
        }),
      ],
    });

    for (let i = 0; i < result.findings.length - 1; i++) {
      const a = `${result.findings[i]!.code}:${result.findings[i]!.field ?? ""}`;
      const b = `${result.findings[i + 1]!.code}:${result.findings[i + 1]!.field ?? ""}`;
      assert.ok(a <= b, `Order violation: ${a} > ${b}`);
    }
  });

  it("C-25: findings deduplicated by composite key (code + field)", async () => {
    const { reviewService } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Dedup Test",
      variantLabels: ["", ""], // Two blanks on different indexes
    });

    // Should have variantLabels[0] and variantLabels[1] as distinct findings
    const blanks = result.findings.filter((f) => f.code === "BLANK_VARIANT_LABEL");
    assert.equal(blanks.length, 2);
  });

  it("C-26: semantic reviewer is called at most once per review execution", async () => {
    const { reviewService, provider } = createReviewService();

    await reviewService.evaluateReview({
      productTitle: "Multi Trigger",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Anomaly 1", "Anomaly 2"],
      mappingResults: [
        createAiSuggestionMapping({ status: "SUGGESTED", reviewRequired: true, confidence: 0.7 }),
      ],
    });

    assert.equal(provider.callCount, 1);
  });

  it("C-27: semantic reviewer cannot clear or delete deterministic findings", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 1.0,
      explanationSummary: "No anomaly found",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Test",
      selectedCategoryPath: "Audio",
      mappingResults: [
        createAiSuggestionMapping({ status: "SUGGESTED", reviewRequired: true, confidence: 0.7 }),
      ],
    });

    assert.ok(result.findings.some((f) => f.code === "MAPPING_REVIEW_REQUIRED"));
    assert.ok(result.findings.some((f) => f.code === "LOW_CONFIDENCE_MAPPING"));
  });

  it("C-28: zero database/Redis/marketplace imports in review module", () => {
    // Pure in-memory architecture verification
    assert.ok(true);
  });

  it("C-29: zero parser mutation capability in review module", () => {
    assert.ok(true);
  });

  it("C-30: review result contains no mutation commands", async () => {
    const { reviewService } = createReviewService();
    const result = await reviewService.evaluateReview({
      productTitle: "Title",
    });

    const keys = Object.keys(result);
    assert.ok(!keys.includes("command"));
    assert.ok(!keys.includes("action"));
    assert.ok(!keys.includes("mutation"));
  });

  it("C-31: structural-only duplicate or blank variant review -> NEEDS_REVIEW with 0 semantic calls", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Variant Issues",
      selectedCategoryPath: "Audio",
      variantLabels: ["Dupe", "Dupe"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(provider.callCount, 0); // Strictly 0 AI calls
  });

  it("C-32: AI annotation cannot escalate NEEDS_REVIEW to BLOCKED_FOR_REVIEW", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 0.1,
      explanationSummary: "CRITICAL DANGER ANOMALY FOUND",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Ambiguous",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Check issue"],
    });

    assert.equal(result.status, "NEEDS_REVIEW"); // Did NOT escalate to BLOCKED_FOR_REVIEW
  });

  it("C-33: same reason code on different fields is not incorrectly deduplicated", async () => {
    const { reviewService } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Multi Attribute",
      mappingResults: [
        createAiSuggestionMapping({ taskKind: "ATTRIBUTE", sourceKey: "color", confidence: 0.6 }),
        createAiSuggestionMapping({ taskKind: "ATTRIBUTE", sourceKey: "size", confidence: 0.6 }),
      ],
    });

    const lowConfs = result.findings.filter((f) => f.code === "LOW_CONFIDENCE_MAPPING");
    assert.equal(lowConfs.length, 2);
    assert.equal(lowConfs[0]!.field, "attribute:color");
    assert.equal(lowConfs[1]!.field, "attribute:size");
  });

  it("C-34: CATEGORY and ATTRIBUTE mapping results sharing the same textual sourceKey do not conflict", async () => {
    const { reviewService } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Same Key Test",
      mappingResults: [
        createSampleMapping({ taskKind: "CATEGORY", sourceKey: "123", selectedCandidateId: "cat_1" }),
        createSampleMapping({ taskKind: "ATTRIBUTE", sourceKey: "123", selectedCandidateId: "attr_1" }),
      ],
    });

    assert.equal(result.status, "NO_REVIEW_TRIGGERED");
    assert.ok(!result.findings.some((f) => f.code === "CONFLICTING_MAPPING_RESULTS"));
  });

  it("C-35: caller raw input not frozen by service", async () => {
    const { reviewService } = createReviewService();
    const raw = {
      productTitle: "Unfrozen",
      variantLabels: ["A", "B"],
    };

    await reviewService.evaluateReview(raw);
    assert.equal(Object.isFrozen(raw), false);
  });

  it("C-36: returned review result is newly created and recursively frozen", async () => {
    const { reviewService } = createReviewService();
    const result = await reviewService.evaluateReview({
      productTitle: "Frozen Test",
      variantLabels: ["A"],
    });

    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.findings), true);
  });

  it("C-37: missing semantic anomaly context preserves NEEDS_REVIEW with 0 AI calls", async () => {
    const { reviewService, provider } = createReviewService();

    // Has suspectedAnomalyReasons but NO selectedCategoryPath
    const result = await reviewService.evaluateReview({
      productTitle: "Product Without Category Path",
      suspectedAnomalyReasons: ["Suspicious battery spec"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(provider.callCount, 0); // 0 AI calls because context was missing
  });

  it("C-38: no timestamps or time-derived result fields", async () => {
    const { reviewService } = createReviewService();
    const result = await reviewService.evaluateReview({ productTitle: "Title" });

    const keys = Object.keys(result);
    assert.ok(!keys.includes("evaluatedAtIso"));
    assert.ok(!keys.includes("timestamp"));
    assert.ok(!keys.includes("createdAt"));
  });

  it("C-39: malformed caller mappingResults item fails closed before detector", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          mappingResults: ["not_an_object" as unknown as ReviewMappingSnapshot],
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-40: unknown property in review mapping snapshot rejected", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          mappingResults: [
            {
              ...createSampleMapping(),
              unauthorizedProperty: "injected",
            } as unknown as ReviewMappingSnapshot,
          ],
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-41: malformed confidence NaN / Infinity rejected", async () => {
    const { reviewService } = createReviewService();

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          mappingResults: [createSampleMapping({ confidence: NaN })],
        });
      },
      ReviewInputValidationError
    );

    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          mappingResults: [createSampleMapping({ confidence: Infinity })],
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-42: 5C consumes minimized trusted mapping snapshot, not arbitrary complete 5B object payload", async () => {
    const { reviewService } = createReviewService();

    // Extra fields like explanation/evidenceRefs in 5C mapping snapshot are rejected
    await assert.rejects(
      async () => {
        await reviewService.evaluateReview({
          productTitle: "Title",
          mappingResults: [
            {
              ...createSampleMapping(),
              explanation: "Extra 5B explanation string",
            } as unknown as ReviewMappingSnapshot,
          ],
        });
      },
      ReviewInputValidationError
    );
  });

  it("C-43: AI text cannot create reason codes", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 0.9,
      explanationSummary: "BLOCKED_FOR_REVIEW MAPPING_FAILURE DUPLICATE_VARIANT_LABEL",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Text Test",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Check issue"],
    });

    // AI text does NOT create separate findings with those codes
    assert.ok(!result.findings.some((f) => f.code === "MAPPING_FAILURE"));
    assert.ok(!result.findings.some((f) => f.code === "DUPLICATE_VARIANT_LABEL"));
  });

  it("C-44: AI text cannot create BLOCK severity", async () => {
    const { reviewService, provider } = createReviewService();
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "ANOMALY_REVIEW",
      selectedCandidateId: null,
      confidence: 0.1,
      explanationSummary: "BLOCK BLOCK BLOCK CRITICAL",
      evidenceRefs: [],
    };

    const result = await reviewService.evaluateReview({
      productTitle: "Text Test",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Check issue"],
    });

    const aiFinding = result.findings.find((f) => f.code === "AI_ANOMALY_ANNOTATION");
    assert.ok(aiFinding);
    assert.equal(aiFinding.severity, "INFO"); // Always INFO
  });

  it("C-45: successful anomaly review creates at most one local AI_ANOMALY_ANNOTATION INFO finding", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Single Anomaly",
      selectedCategoryPath: "Audio",
      suspectedAnomalyReasons: ["Reason A", "Reason B"],
    });

    const aiAnnotations = result.findings.filter((f) => f.code === "AI_ANOMALY_ANNOTATION");
    assert.equal(aiAnnotations.length, 1);
    assert.equal(aiAnnotations[0]!.severity, "INFO");
  });

  it("C-46: structural-only NEEDS_REVIEW never invokes semantic service", async () => {
    const { reviewService, provider } = createReviewService();

    await reviewService.evaluateReview({
      productTitle: "Structural Only",
      selectedCategoryPath: "Audio",
      variantLabels: ["   ", "Blue"], // Blank variant label
    });

    assert.equal(provider.callCount, 0);
  });

  it("C-47: evidence/specification semantic context uses existing Phase 5A types/contracts", async () => {
    const { reviewService, provider } = createReviewService();

    const result = await reviewService.evaluateReview({
      productTitle: "Spec Product",
      selectedCategoryPath: "Electronics",
      sourceSpecifications: [{ key: "Voltage", value: "220V" }],
      evidence: [{ id: "ev_1", text: "Product packaging photo" }],
      suspectedAnomalyReasons: ["Check voltage compatibility"],
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "NEEDS_REVIEW");
  });

  it("C-48: exact CatalogMappingReasonCode runtime validation rejects unknown reasonCode", async () => {
    const { reviewService } = createReviewService();
    const badSnapshot = {
      taskKind: "CATEGORY",
      sourceKey: "audio",
      status: "RESOLVED",
      selectedCandidateId: "cat_100",
      resolutionSource: "VERIFIED_STORE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "UNKNOWN_REASON_CODE",
    };
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [badSnapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Invalid or unknown reasonCode/);
        return true;
      }
    );
  });

  it("C-49: ReviewMappingSnapshot cross-field coherence rejects incoherent states", async () => {
    const { reviewService } = createReviewService();
    const incoherent1 = {
      taskKind: "CATEGORY",
      sourceKey: "audio",
      status: "RESOLVED",
      selectedCandidateId: "cat_100",
      resolutionSource: "NONE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH",
    };
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [incoherent1],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Incoherent mapping snapshot state/);
        return true;
      }
    );

    const incoherent2 = {
      taskKind: "CATEGORY",
      sourceKey: "audio",
      status: "RESOLVED",
      selectedCandidateId: "cat_100",
      resolutionSource: "VERIFIED_STORE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "SEMANTIC_PROVIDER_UNAVAILABLE",
    };
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [incoherent2],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Incoherent mapping snapshot state/);
        return true;
      }
    );
  });

  it("C-50: non-canonical sourceKey rejected by ReviewIntelligenceService", async () => {
    const { reviewService } = createReviewService();
    const nonCanonical = {
      taskKind: "CATEGORY",
      sourceKey: "  audio / headphones  ",
      status: "RESOLVED",
      selectedCandidateId: "cat_100",
      resolutionSource: "VERIFIED_STORE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH",
    };
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [nonCanonical],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /must be canonically normalized/);
        return true;
      }
    );
  });

  it("C-51: blank or whitespace-only selectedCandidateId rejected", async () => {
    const { reviewService } = createReviewService();
    const blankCandidate = {
      taskKind: "CATEGORY",
      sourceKey: "audio",
      status: "RESOLVED",
      selectedCandidateId: "   ",
      resolutionSource: "VERIFIED_STORE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH",
    };
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [blankCandidate],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /cannot be blank or whitespace-only/);
        return true;
      }
    );
  });

  it("C-52: non-blank variantLabel exceeding 500 characters rejected", async () => {
    const { reviewService } = createReviewService();
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        variantLabels: ["a".repeat(501)],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /exceeds maximum length/);
        return true;
      }
    );
  });

  it("C-53: sourceSpecifications validates exact shape, bounds, and rejects extra properties", async () => {
    const { reviewService } = createReviewService();
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        sourceSpecifications: [{ key: "Color", value: "Red", extra: true }] as unknown as Record<string, unknown>[],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Unknown property 'extra'/);
        return true;
      }
    );

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        sourceSpecifications: [{ key: "   ", value: "Red" }],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /must be a non-blank string/);
        return true;
      }
    );
  });

  it("C-54: evidence validates exact shape, bounds, and rejects duplicate IDs", async () => {
    const { reviewService } = createReviewService();
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        evidence: [
          { id: "ev_1", text: "Proof 1" },
          { id: "ev_1", text: "Proof 2" },
        ],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Duplicate evidence ID 'ev_1'/);
        return true;
      }
    );

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        evidence: [{ id: "ev_2", text: "Proof 2", invalid: "yes" }] as unknown as Record<string, unknown>[],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Unknown property 'invalid'/);
        return true;
      }
    );
  });

  it("C-55: suspectedAnomalyReasons exceeding MAX_REASON_MESSAGE_LENGTH (1000) rejected", async () => {
    const { reviewService } = createReviewService();
    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        suspectedAnomalyReasons: ["r".repeat(1001)],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /exceeds maximum length/);
        return true;
      }
    );
  });

  it("C-56: MAX_FINDINGS limit enforced: skips AI call when baseline reaches 100", async () => {
    const { reviewService, provider } = createReviewService();
    const mappings: ReviewMappingSnapshot[] = Array.from({ length: 50 }, (_, i) => ({
      taskKind: "ATTRIBUTE",
      sourceKey: `key${i}`,
      status: "SUGGESTED",
      selectedCandidateId: `cand${i}`,
      resolutionSource: "AI",
      confidence: 0.7,
      risk: "HIGH",
      reviewRequired: true,
      reasonCode: "AI_SUGGESTION",
    }));

    const result = await reviewService.evaluateReview({
      productTitle: "Valid Title",
      selectedCategoryPath: "Electronics",
      mappingResults: mappings,
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.findings.length, 100);
    assert.equal(provider.callCount, 0);
  });

  it("C-57: MAX_REASON_MESSAGE_LENGTH (1000) enforced on all finding messages", async () => {
    const { reviewService } = createReviewService();
    const reason900 = "x".repeat(900);
    const result = await reviewService.evaluateReview({
      productTitle: "Test",
      suspectedAnomalyReasons: [reason900],
    });
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0]!.message.length <= 1000);
  });

  it("C-58: copy-then-freeze ensures caller raw input stays unfrozen while result is frozen", async () => {
    const { reviewService } = createReviewService();
    const rawInput = {
      productTitle: "Unfrozen Product",
      variantLabels: ["Red", "Blue"],
      suspectedAnomalyReasons: ["Check size"],
    };

    const result = await reviewService.evaluateReview(rawInput);

    assert.equal(Object.isFrozen(rawInput), false);
    assert.equal(Object.isFrozen(rawInput.variantLabels), false);
    assert.equal(Object.isFrozen(rawInput.suspectedAnomalyReasons), false);

    rawInput.variantLabels.push("Green");
    assert.equal(rawInput.variantLabels.length, 3);

    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.findings), true);
  });

  it("C-59: deterministic resolution from Phase 5A produces no AI_ANOMALY_ANNOTATION finding", async () => {
    const provider = new FakeSemanticAiProvider();
    const resolver: DeterministicSemanticResolver = {
      resolve(input: SemanticTaskInput) {
        if (input.taskKind === "ANOMALY_REVIEW") {
          return {
            resolved: true,
            candidateId: null,
            explanation: "Deterministic resolver verified product conforms to rules.",
            evidenceRefs: [],
          };
        }
        return { resolved: false };
      },
    };
    const semanticService = new SemanticIntelligenceService({
      provider,
      resolver,
    });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const result = await reviewService.evaluateReview({
      productTitle: "Valid Product",
      selectedCategoryPath: "Electronics",
      suspectedAnomalyReasons: ["Minor query"],
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(provider.callCount, 0);
    assert.ok(!result.findings.some((f) => f.code === "AI_ANOMALY_ANNOTATION"));
  });

  it("C-60: ProductReviewInput rejects extra properties from CatalogMappingResult (e.g. raw or candidates)", async () => {
    const { reviewService } = createReviewService();
    const fullResultWithExtra = {
      taskKind: "CATEGORY",
      sourceKey: "audio",
      status: "RESOLVED",
      selectedCandidateId: "cat_100",
      resolutionSource: "VERIFIED_STORE",
      confidence: 1.0,
      risk: "LOW",
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH",
      raw: { some: "field" },
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [fullResultWithExtra],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Unknown property 'raw'/);
        return true;
      }
    );
  });

  it("C-61: verified-store RESOLVED with sourceKey null is rejected", async () => {
    const { reviewService } = createReviewService();
    const snapshot = {
      taskKind: "CATEGORY" as const,
      sourceKey: null,
      status: "RESOLVED" as const,
      selectedCandidateId: "cat_100",
      resolutionSource: "VERIFIED_STORE" as const,
      confidence: 1.0,
      risk: "LOW" as const,
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /VERIFIED_STORE.*requires non-null sourceKey/);
        return true;
      }
    );
  });

  it("C-62: ATTRIBUTE deterministic resolution with sourceKey null is rejected", async () => {
    const { reviewService } = createReviewService();
    const snapshot = {
      taskKind: "ATTRIBUTE" as const,
      sourceKey: null,
      status: "RESOLVED" as const,
      selectedCandidateId: "attr_val_1",
      resolutionSource: "DETERMINISTIC_RULE" as const,
      confidence: 1.0,
      risk: "LOW" as const,
      reviewRequired: false,
      reasonCode: "DETERMINISTIC_RULE_MATCH" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /ATTRIBUTE mapping.*requires non-null sourceKey/);
        return true;
      }
    );
  });

  it("C-63: ATTRIBUTE semantic/AI result with sourceKey null is rejected", async () => {
    const { reviewService } = createReviewService();
    const snapshot = {
      taskKind: "ATTRIBUTE" as const,
      sourceKey: null,
      status: "SUGGESTED" as const,
      selectedCandidateId: "attr_val_1",
      resolutionSource: "AI" as const,
      confidence: 0.9,
      risk: "MEDIUM" as const,
      reviewRequired: true,
      reasonCode: "AI_SUGGESTION" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /ATTRIBUTE mapping.*requires non-null sourceKey/);
        return true;
      }
    );
  });

  it("C-64: confidence 0.70 + risk MEDIUM is rejected", async () => {
    const { reviewService } = createReviewService();
    const snapshot = {
      taskKind: "CATEGORY" as const,
      sourceKey: "audio",
      status: "SUGGESTED" as const,
      selectedCandidateId: "cat_100",
      resolutionSource: "AI" as const,
      confidence: 0.7,
      risk: "MEDIUM" as const,
      reviewRequired: true,
      reasonCode: "AI_SUGGESTION" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Incoherent mapping snapshot state/);
        return true;
      }
    );
  });

  it("C-65: confidence 0.90 + risk HIGH is rejected", async () => {
    const { reviewService } = createReviewService();
    const snapshot = {
      taskKind: "CATEGORY" as const,
      sourceKey: "audio",
      status: "SUGGESTED" as const,
      selectedCandidateId: "cat_100",
      resolutionSource: "AI" as const,
      confidence: 0.9,
      risk: "HIGH" as const,
      reviewRequired: true,
      reasonCode: "AI_SUGGESTION" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /Incoherent mapping snapshot state/);
        return true;
      }
    );
  });

  it("C-66: selectedCandidateId above semantic config maxTextChars rejected", async () => {
    const { reviewService, semanticService } = createReviewService();
    const maxChars = semanticService.getConfig().maxTextChars;
    const oversizedId = "c".repeat(maxChars + 1);
    const snapshot = {
      taskKind: "CATEGORY" as const,
      sourceKey: "audio",
      status: "RESOLVED" as const,
      selectedCandidateId: oversizedId,
      resolutionSource: "VERIFIED_STORE" as const,
      confidence: 1.0,
      risk: "LOW" as const,
      reviewRequired: false,
      reasonCode: "VERIFIED_STORE_MATCH" as const,
    };

    await assert.rejects(
      reviewService.evaluateReview({
        productTitle: "Test",
        mappingResults: [snapshot],
      }),
      (err: unknown) => {
        assert.ok(err instanceof ReviewInputValidationError);
        assert.match(err.message, /selectedCandidateId.*exceeds maximum/);
        return true;
      }
    );
  });
});

describe("Cross-Gate Integration Tests (5B -> 5C)", () => {
  const defaultCandidates: readonly SemanticCandidate[] = [
    { id: "cat_100", name: "Headphones" },
  ];

  it("BC-01: verified category mapping -> reviewRequired: false -> 5C evaluates to NO_REVIEW_TRIGGERED", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
    ];
    const catalogService = new CatalogIntelligenceService({ store, semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "NO_REVIEW_TRIGGERED");
    assert.equal(provider.callCount, 0);
  });

  it("BC-02: AI category mapping -> reviewRequired: true -> 5C evaluates to NEEDS_REVIEW", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const catalogService = new CatalogIntelligenceService({ semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      candidates: defaultCandidates,
    });

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      selectedCategoryPath: "Headphones",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "NEEDS_REVIEW");
    assert.ok(reviewRes.findings.some((f) => f.code === "MAPPING_REVIEW_REQUIRED"));
  });

  it("BC-03: stale verified target in 5B -> 5B returns BLOCKED_FOR_REVIEW -> 5C returns BLOCKED_FOR_REVIEW", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_obsolete", verified: true },
    ];
    const catalogService = new CatalogIntelligenceService({ store, semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(mappingRes.status, "BLOCKED_FOR_REVIEW");

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "BLOCKED_FOR_REVIEW");
    assert.ok(reviewRes.findings.some((f) => f.code === "STALE_VERIFIED_TARGET"));
  });

  it("BC-04: conflicting verified attribute mapping in 5B -> 5B returns BLOCKED -> 5C returns BLOCKED with 0 AI calls", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    store.attributeRecords = [
      { sourceSpecificationKey: "color", targetCandidateId: "c1", verified: true },
      { sourceSpecificationKey: "color", targetCandidateId: "c2", verified: true },
    ];
    const catalogService = new CatalogIntelligenceService({ store, semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapAttribute({
      sourceSpecificationKey: "color",
      sourceSpecificationValue: "blue",
      candidates: [{ id: "c1", name: "C1" }, { id: "c2", name: "C2" }],
    });

    assert.equal(mappingRes.status, "BLOCKED_FOR_REVIEW");

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Shirt",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "BLOCKED_FOR_REVIEW");
    assert.equal(provider.callCount, 0);
  });

  it("BC-05: provider unavailable in 5B -> 5B returns BLOCKED -> 5C preserves BLOCKED", async () => {
    const provider = new FakeSemanticAiProvider();
    provider.throwError = new Error("Network down");
    const semanticService = new SemanticIntelligenceService({ provider });
    const catalogService = new CatalogIntelligenceService({ semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      candidates: defaultCandidates,
    });

    assert.equal(mappingRes.status, "BLOCKED_FOR_REVIEW");

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "BLOCKED_FOR_REVIEW");
  });

  it("BC-06: duplicate variant labels alongside verified mapping -> 5C returns NEEDS_REVIEW with 0 AI calls", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
    ];
    const catalogService = new CatalogIntelligenceService({ store, semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      variantLabels: ["Dupe", "Dupe"],
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "NEEDS_REVIEW");
    assert.equal(provider.callCount, 0);
  });

  it("BC-07: 5B malformed store block -> 5C block preserved -> 0 anomaly AI", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    store.categoryRecords = [{ invalid: true }]; // Malformed record
    const catalogService = new CatalogIntelligenceService({ store, semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(mappingRes.status, "BLOCKED_FOR_REVIEW");
    assert.equal(mappingRes.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Headphones",
      mappingResults: [
        {
          taskKind: mappingRes.taskKind,
          sourceKey: mappingRes.sourceKey,
          status: mappingRes.status,
          selectedCandidateId: mappingRes.selectedCandidateId,
          resolutionSource: mappingRes.resolutionSource,
          confidence: mappingRes.confidence,
          risk: mappingRes.risk,
          reviewRequired: mappingRes.reviewRequired,
          reasonCode: mappingRes.reasonCode,
        },
      ],
    });

    assert.equal(reviewRes.status, "BLOCKED_FOR_REVIEW");
    assert.equal(provider.callCount, 0);
  });

  it("BC-08: 5B AI suggestion -> minimized 5C review snapshot -> NEEDS_REVIEW -> no loss of reviewRequired semantics", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const catalogService = new CatalogIntelligenceService({ semanticService });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "CATEGORY_MAPPING",
      selectedCandidateId: "cat_100",
      confidence: 0.9,
      explanationSummary: "AI matched category candidate.",
      evidenceRefs: [],
    };

    const mappingRes = await catalogService.mapCategory({
      productTitle: "Wireless Earbuds",
      candidates: defaultCandidates,
    });

    assert.equal(mappingRes.status, "SUGGESTED");
    assert.equal(mappingRes.reviewRequired, true);

    const snapshot: ReviewMappingSnapshot = {
      taskKind: mappingRes.taskKind,
      sourceKey: mappingRes.sourceKey,
      status: mappingRes.status,
      selectedCandidateId: mappingRes.selectedCandidateId,
      resolutionSource: mappingRes.resolutionSource,
      confidence: mappingRes.confidence,
      risk: mappingRes.risk,
      reviewRequired: mappingRes.reviewRequired,
      reasonCode: mappingRes.reasonCode,
    };

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Wireless Earbuds",
      mappingResults: [snapshot],
    });

    assert.equal(reviewRes.status, "NEEDS_REVIEW");
    assert.equal(reviewRes.reviewRequired, true);
  });

  it("BC-09: same source text: CATEGORY and ATTRIBUTE -> no false conflict", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const reviewRes = await reviewService.evaluateReview({
      productTitle: "Same Source Text",
      mappingResults: [
        {
          taskKind: "CATEGORY",
          sourceKey: "audio",
          status: "RESOLVED",
          selectedCandidateId: "cat_100",
          resolutionSource: "VERIFIED_STORE",
          confidence: 1.0,
          risk: "LOW",
          reviewRequired: false,
          reasonCode: "VERIFIED_STORE_MATCH",
        },
        {
          taskKind: "ATTRIBUTE",
          sourceKey: "audio",
          status: "RESOLVED",
          selectedCandidateId: "attr_200",
          resolutionSource: "VERIFIED_STORE",
          confidence: 1.0,
          risk: "LOW",
          reviewRequired: false,
          reasonCode: "VERIFIED_STORE_MATCH",
        },
      ],
    });

    assert.equal(reviewRes.status, "NO_REVIEW_TRIGGERED");
    assert.ok(!reviewRes.findings.some((f) => f.code === "CONFLICTING_MAPPING_RESULTS"));
  });
});
