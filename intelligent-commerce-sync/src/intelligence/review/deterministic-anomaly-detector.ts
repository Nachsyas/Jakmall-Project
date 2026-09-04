/**
 * Phase 5C: Deterministic Anomaly Detector
 * Pure, deterministic evaluation of structural invariants and catalog mapping results.
 * Authoritative for BLOCKED_FOR_REVIEW and baseline review status.
 */

import { normalizeLookupKey } from "../catalog/normalization.js";
import {
  type ReviewFinding,
  type ReviewStatus,
  type ReviewMappingSnapshot,
  REVIEW_BOUNDS,
  ReviewInputValidationError,
} from "./types.js";

export interface TrustedProductReviewData {
  readonly productTitle?: string | undefined;
  readonly selectedCategoryPath?: string | undefined;
  readonly mappingResults?: readonly ReviewMappingSnapshot[] | undefined;
  readonly variantLabels?: readonly string[] | undefined;
  readonly suspectedAnomalyReasons?: readonly string[] | undefined;
}

interface InternalFinding {
  readonly finding: ReviewFinding;
  readonly identityKey: string;
}

/**
 * Evaluates structural rules and mapping outcomes deterministically:
 * 1. Checks catalog mappings for blocks, failures, low confidence, and review requests.
 * 2. Groups mappings by (taskKind, sourceKey) to detect conflicting candidates.
 * 3. Inspects variant labels for blankness and normalized duplicates.
 * 4. Captures caller-flagged suspected anomalies.
 * 5. Deduplicates findings using structured composite identity (code + field + subject).
 * 6. Stably sorts findings via locale-independent code-unit comparison.
 * 7. Enforces MAX_FINDINGS and MAX_REASON_MESSAGE_LENGTH bounds.
 * 8. Computes deterministic baseline status (BLOCK > REVIEW > NO_REVIEW).
 */
export function detectDeterministicAnomalies(data: TrustedProductReviewData): {
  status: ReviewStatus;
  findings: readonly ReviewFinding[];
} {
  const rawFindings: InternalFinding[] = [];

  // 1. Evaluate Mapping Results
  if (data.mappingResults && data.mappingResults.length > 0) {
    for (const m of data.mappingResults) {
      const field = `${m.taskKind.toLowerCase()}:${m.sourceKey ?? "unknown"}`;

      if (m.status === "BLOCKED_FOR_REVIEW") {
        if (m.reasonCode === "CONFLICTING_VERIFIED_MAPPING") {
          const finding: ReviewFinding = {
            code: "CONFLICTING_VERIFIED_MAPPING",
            severity: "BLOCK",
            message: `Conflicting verified store mapping detected for '${m.sourceKey}'.`,
            field,
          };
          rawFindings.push({
            finding,
            identityKey: `${finding.code}:${field}`,
          });
        } else if (m.reasonCode === "STALE_VERIFIED_TARGET") {
          const finding: ReviewFinding = {
            code: "STALE_VERIFIED_TARGET",
            severity: "BLOCK",
            message: `Stale verified mapping target detected for '${m.sourceKey}'.`,
            field,
          };
          rawFindings.push({
            finding,
            identityKey: `${finding.code}:${field}`,
          });
        } else {
          const finding: ReviewFinding = {
            code: "MAPPING_FAILURE",
            severity: "BLOCK",
            message: `Catalog mapping failed closed with reason '${m.reasonCode}'.`,
            field,
          };
          rawFindings.push({
            finding,
            identityKey: `${finding.code}:${field}:${m.reasonCode}`,
          });
        }
      } else if (m.status === "NEEDS_REVIEW" || m.reviewRequired) {
        const finding: ReviewFinding = {
          code: "MAPPING_REVIEW_REQUIRED",
          severity: "REVIEW",
          message: `Catalog mapping requires review (reason: ${m.reasonCode}).`,
          field,
        };
        rawFindings.push({
          finding,
          identityKey: `${finding.code}:${field}:${m.reasonCode}`,
        });
      }

      if (m.confidence !== null && m.confidence < 0.8) {
        const finding: ReviewFinding = {
          code: "LOW_CONFIDENCE_MAPPING",
          severity: "REVIEW",
          message: `Catalog mapping confidence (${m.confidence}) is below the 0.80 safety threshold.`,
          field,
        };
        rawFindings.push({
          finding,
          identityKey: `${finding.code}:${field}:${m.selectedCandidateId ?? "null"}`,
        });
      }
    }

    // 2. Mapping Conflict Detection (Group by taskKind + sourceKey; ignore null sourceKey)
    const mappingGroups = new Map<string, ReviewMappingSnapshot[]>();
    for (const m of data.mappingResults) {
      if (m.sourceKey !== null) {
        const groupKey = `${m.taskKind}:${m.sourceKey}`;
        const existing = mappingGroups.get(groupKey);
        if (existing) {
          existing.push(m);
        } else {
          mappingGroups.set(groupKey, [m]);
        }
      }
    }

    for (const [groupKey, group] of mappingGroups.entries()) {
      if (group.length > 1) {
        const selectedCandidateIds = new Set<string>();
        for (const m of group) {
          if (m.selectedCandidateId !== null) {
            selectedCandidateIds.add(m.selectedCandidateId);
          }
        }
        if (selectedCandidateIds.size > 1) {
          const colonIndex = groupKey.indexOf(":");
          const taskKind = groupKey.slice(0, colonIndex).toLowerCase();
          const sourceKey = groupKey.slice(colonIndex + 1);
          const finding: ReviewFinding = {
            code: "CONFLICTING_MAPPING_RESULTS",
            severity: "BLOCK",
            message: `Conflicting mapping candidates detected for ${groupKey} (${selectedCandidateIds.size} distinct candidates).`,
            field: `${taskKind}:${sourceKey}`,
          };
          rawFindings.push({
            finding,
            identityKey: `${finding.code}:${finding.field}`,
          });
        }
      }
    }
  }

  // 3. Variant Labels Evaluation
  if (data.variantLabels !== undefined) {
    const seenNormalizedLabels = new Map<string, number>();

    for (let i = 0; i < data.variantLabels.length; i++) {
      const rawLabel = data.variantLabels[i]!;

      // Blank check: empty or whitespace-only
      if (rawLabel.trim().length === 0) {
        const finding: ReviewFinding = {
          code: "BLANK_VARIANT_LABEL",
          severity: "REVIEW",
          message: `Variant label at index ${i} is blank or whitespace-only.`,
          field: `variantLabels[${i}]`,
        };
        rawFindings.push({
          finding,
          identityKey: `${finding.code}:${finding.field}`,
        });
      } else {
        // Single canonical normalizer: fail closed if invalid
        const normalized = normalizeLookupKey(rawLabel);

        const prevIndex = seenNormalizedLabels.get(normalized);
        if (prevIndex !== undefined) {
          const finding: ReviewFinding = {
            code: "DUPLICATE_VARIANT_LABEL",
            severity: "REVIEW",
            message: `Duplicate variant label at index ${i} matches index ${prevIndex}.`,
            field: `variantLabels[${i}]`,
          };
          rawFindings.push({
            finding,
            identityKey: `${finding.code}:${finding.field}:${normalized}`,
          });
        } else {
          seenNormalizedLabels.set(normalized, i);
        }
      }
    }
  }

  // 4. Suspected Anomaly Reasons
  if (data.suspectedAnomalyReasons !== undefined) {
    for (let i = 0; i < data.suspectedAnomalyReasons.length; i++) {
      const reason = data.suspectedAnomalyReasons[i]!;
      const finding: ReviewFinding = {
        code: "SUSPECTED_ANOMALY_FLAGGED",
        severity: "REVIEW",
        message: `Caller flagged suspected anomaly: ${reason}`,
        field: `suspectedAnomalyReasons[${i}]`,
      };
      rawFindings.push({
        finding,
        identityKey: `${finding.code}:${finding.field}`,
      });
    }
  }

  // 5. Composite Identity Deduplication
  const dedupedFindings: ReviewFinding[] = [];
  const seenKeys = new Set<string>();

  for (const item of rawFindings) {
    if (item.finding.message.length > REVIEW_BOUNDS.MAX_REASON_MESSAGE_LENGTH) {
      throw new ReviewInputValidationError(
        `ReviewFinding message exceeds maximum length bound (${REVIEW_BOUNDS.MAX_REASON_MESSAGE_LENGTH}).`
      );
    }
    if (!seenKeys.has(item.identityKey)) {
      seenKeys.add(item.identityKey);
      dedupedFindings.push(item.finding);
    }
  }

  // Enforce MAX_FINDINGS before returning
  if (dedupedFindings.length > REVIEW_BOUNDS.MAX_FINDINGS) {
    throw new ReviewInputValidationError(
      `Total review findings count (${dedupedFindings.length}) exceeds maximum limit (${REVIEW_BOUNDS.MAX_FINDINGS}).`
    );
  }

  // 6. Locale-Independent Code-Unit Sorting
  dedupedFindings.sort((a, b) => {
    const keyA = `${a.code}:${a.field ?? ""}`;
    const keyB = `${b.code}:${b.field ?? ""}`;
    if (keyA !== keyB) {
      return keyA < keyB ? -1 : 1;
    }
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

  // 7. Baseline Review Status Determination
  let status: ReviewStatus = "NO_REVIEW_TRIGGERED";
  if (dedupedFindings.some((f) => f.severity === "BLOCK")) {
    status = "BLOCKED_FOR_REVIEW";
  } else if (dedupedFindings.some((f) => f.severity === "REVIEW")) {
    status = "NEEDS_REVIEW";
  }

  return {
    status,
    findings: Object.freeze(dedupedFindings),
  };
}
