/**
 * Phase 5A: Semantic Intelligence Service
 * Deterministic-First Orchestrator with Enforced Timeout & Safe Failure Contracts
 */

import {
  resolveSemanticConfig,
  type SemanticIntelligenceConfig,
} from "./config.js";
import {
  validateSemanticTaskInput,
  generateSemanticRequestId,
  computeDeterministicRisk,
  sanitizeErrorMessage,
  getCanonicalCandidateIds,
  getCanonicalEvidenceIds,
} from "./safety.js";
import { buildSemanticProviderRequest } from "./prompt-builder.js";
import {
  validateSemanticOutput,
  validateDeterministicResolution,
  validateSemanticProviderResponse,
} from "./output-validator.js";
import {
  SemanticOutputValidationError,
  SemanticProviderError,
  type SemanticTaskInput,
  type SemanticAiProvider,
  type DeterministicSemanticResolver,
  type SemanticIntelligenceResult,
  type SemanticTaskKind,
} from "./types.js";

export class SemanticIntelligenceService {
  private readonly config: SemanticIntelligenceConfig;
  private readonly provider: SemanticAiProvider;
  private readonly resolver?: DeterministicSemanticResolver | undefined;

  constructor(options: {
    provider: SemanticAiProvider;
    resolver?: DeterministicSemanticResolver | undefined;
    config?: Partial<SemanticIntelligenceConfig> | undefined;
  }) {
    if (!options || !options.provider || typeof options.provider.complete !== "function") {
      throw new SemanticProviderError("SemanticIntelligenceService requires a valid SemanticAiProvider.");
    }

    if (
      options.resolver !== undefined &&
      (typeof options.resolver !== "object" || options.resolver === null || typeof options.resolver.resolve !== "function")
    ) {
      throw new SemanticProviderError("SemanticIntelligenceService received an invalid DeterministicSemanticResolver.");
    }

    this.provider = options.provider;
    this.resolver = options.resolver;
    this.config = resolveSemanticConfig(options.config);
  }

  getConfig(): SemanticIntelligenceConfig {
    return this.config;
  }

  async executeTask(rawInput: unknown): Promise<SemanticIntelligenceResult> {
    // 1. Validate Input (Runtime Strict Schema & Aggregate Bounds)
    let validTaskInput: SemanticTaskInput;
    try {
      validTaskInput = validateSemanticTaskInput(rawInput, this.config);
    } catch (err: unknown) {
      const sanitized = sanitizeErrorMessage(err);
      let detectedKind: SemanticTaskKind | null = null;
      if (typeof rawInput === "object" && rawInput !== null && "taskKind" in rawInput) {
        const k = (rawInput as Record<string, unknown>).taskKind;
        if (
          k === "CATEGORY_MAPPING" ||
          k === "ATTRIBUTE_MAPPING" ||
          k === "ANOMALY_REVIEW" ||
          k === "PARSER_RECOVERY_SUGGESTION"
        ) {
          detectedKind = k;
        }
      }

      return {
        outcome: "INPUT_REJECTED",
        schemaVersion: 1,
        taskKind: detectedKind,
        requestId: null,
        selectedCandidateId: null,
        confidence: null,
        risk: null,
        reviewRequired: true,
        explanationSummary: "Caller semantic input was rejected due to schema or bounds violation.",
        evidenceRefs: [],
        source: "NONE",
        error: sanitized,
      };
    }

    // 2. Generate Deterministic Request ID from immutable snapshot
    const requestId = generateSemanticRequestId(validTaskInput.taskKind, validTaskInput);

    const allowedCandidateIds = getCanonicalCandidateIds(validTaskInput);
    const allowedEvidenceIds = getCanonicalEvidenceIds(validTaskInput);

    // 3. Deterministic-First Resolution (Rules & Verified Cache)
    if (this.resolver) {
      try {
        const rawResolution = await Promise.resolve(this.resolver.resolve(validTaskInput));
        const resolution = validateDeterministicResolution(
          validTaskInput.taskKind,
          rawResolution,
          this.config,
          allowedCandidateIds,
          allowedEvidenceIds
        );

        if (resolution.resolved) {
          const reviewRequired =
            validTaskInput.taskKind === "ANOMALY_REVIEW" ||
            validTaskInput.taskKind === "PARSER_RECOVERY_SUGGESTION";

          return {
            outcome: "RESOLVED_DETERMINISTICALLY",
            schemaVersion: 1,
            taskKind: validTaskInput.taskKind,
            requestId,
            selectedCandidateId: resolution.candidateId ?? null,
            confidence: 1.0,
            risk: computeDeterministicRisk(validTaskInput.taskKind, 1.0, resolution.candidateId ?? null, "DETERMINISTIC"),
            reviewRequired,
            explanationSummary: resolution.explanation ?? "Resolved via deterministic rule or verified mapping.",
            evidenceRefs: resolution.evidenceRefs ?? [],
            source: "DETERMINISTIC",
          };
        }
      } catch (err: unknown) {
        // Deterministic resolver failed or returned invalid shape: fail closed, provider is NOT called
        const sanitized = sanitizeErrorMessage(err);
        return {
          outcome: "DETERMINISTIC_RESOLVER_FAILURE",
          schemaVersion: 1,
          taskKind: validTaskInput.taskKind,
          requestId,
          selectedCandidateId: null,
          confidence: null,
          risk: null,
          reviewRequired: true,
          explanationSummary: "Deterministic resolution failed safety, shape, or candidate allowlist validation.",
          evidenceRefs: [],
          source: "NONE",
          error: sanitized,
        };
      }
    }

    // 4. AI Provider Invocation with Enforced Timeout & AbortSignal
    const controller = new AbortController();
    const request = buildSemanticProviderRequest(validTaskInput, requestId, controller.signal);

    let timer: NodeJS.Timeout | null = null;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SemanticProviderError(`Provider call timed out after ${this.config.providerTimeoutMs}ms.`));
        }, this.config.providerTimeoutMs);
      });

      const rawResponse = await Promise.race([
        this.provider.complete(request),
        timeoutPromise,
      ]);

      // 5. Strict Provider Response Envelope Validation (Layer 1)
      const envelope = validateSemanticProviderResponse(rawResponse);

      // 6. Strict Output Validation (Layer 2: JSON semantic schema)
      const output = validateSemanticOutput(
        envelope.rawText,
        validTaskInput.taskKind,
        this.config,
        allowedCandidateIds,
        allowedEvidenceIds
      );

      // 6. Local Deterministic Risk & Outcome Classification
      const risk = computeDeterministicRisk(
        validTaskInput.taskKind,
        output.confidence,
        output.selectedCandidateId,
        "AI"
      );

      let outcome: "SUGGESTED" | "NEEDS_REVIEW";
      if (
        (validTaskInput.taskKind === "CATEGORY_MAPPING" || validTaskInput.taskKind === "ATTRIBUTE_MAPPING") &&
        output.selectedCandidateId === null
      ) {
        outcome = "NEEDS_REVIEW";
      } else {
        outcome = "SUGGESTED";
      }

      return {
        outcome,
        schemaVersion: 1,
        taskKind: validTaskInput.taskKind,
        requestId,
        selectedCandidateId: output.selectedCandidateId,
        confidence: output.confidence,
        risk,
        reviewRequired: true, // Always true for AI-derived results in Phase 5A
        explanationSummary: output.explanationSummary,
        evidenceRefs: output.evidenceRefs,
        source: "AI",
      };
    } catch (err: unknown) {
      const sanitized = sanitizeErrorMessage(err);

      if (err instanceof SemanticOutputValidationError) {
        return {
          outcome: "INVALID_PROVIDER_OUTPUT",
          schemaVersion: 1,
          taskKind: validTaskInput.taskKind,
          requestId,
          selectedCandidateId: null,
          confidence: null,
          risk: null,
          reviewRequired: true,
          explanationSummary: "Provider returned output that violated strict schema or allowlist rules.",
          evidenceRefs: [],
          source: "NONE",
          error: sanitized,
        };
      }

      // Provider failure, timeout, or abort
      return {
        outcome: "PROVIDER_UNAVAILABLE",
        schemaVersion: 1,
        taskKind: validTaskInput.taskKind,
        requestId,
        selectedCandidateId: null,
        confidence: null,
        risk: null,
        reviewRequired: true,
        explanationSummary: "Semantic AI provider was unavailable or timed out.",
        evidenceRefs: [],
        source: "NONE",
        error: sanitized,
      };
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }
}
