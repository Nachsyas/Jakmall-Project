/**
 * Phase 5D: Deterministic Parser Diagnostics
 * Authoritative, pure deterministic diagnostic analysis & local investigation guidance
 */

import {
  type ParserRecoveryFailureCode,
  type ParserRecoveryObservation,
  type ParserDiagnosticCode,
  type ParserDiagnosticFinding,
  PARSER_RECOVERY_BOUNDS,
} from "./types.js";

export const NON_SEMANTIC_BLOCKER_FAILURE_CODES = new Set<ParserRecoveryFailureCode>([
  "INVALID_SOURCE_URL",
  "SSRF_BLOCKED",
  "SOURCE_RATE_LIMITED",
  "PRODUCT_NOT_FOUND",
  "SOURCE_FETCH_FAILED",
]);

export const NON_SEMANTIC_BLOCKER_OBSERVATIONS = new Set<ParserRecoveryObservation>([
  "FETCH_TIMEOUT_OBSERVED",
]);

export const STRUCTURAL_DIAGNOSTIC_CODES = new Set<ParserDiagnosticCode>([
  "DIAG_PRODUCT_TITLE_MISSING",
  "DIAG_SPDT_SCHEMA_MISMATCH",
  "DIAG_EXTRACTION_FAILED_UNKNOWN",
  "DIAG_JSON_LD_PRODUCT_MISSING",
  "DIAG_JSON_LD_PRICE_INVALID",
  "DIAG_AUTHORITATIVE_PRICE_MISSING",
  "DIAG_AUTHORITATIVE_PRICE_INVALID",
  "DIAG_SPDT_SCRIPT_MISSING_OBSERVED",
  "DIAG_SPDT_SYNTAX_FAILURE_OBSERVED",
  "DIAG_SKU_RECORD_EMPTY_OBSERVED",
]);

export function hasNonSemanticBlocker(
  failureCode?: ParserRecoveryFailureCode | undefined,
  observations?: readonly ParserRecoveryObservation[] | undefined
): boolean {
  if (failureCode !== undefined && NON_SEMANTIC_BLOCKER_FAILURE_CODES.has(failureCode)) {
    return true;
  }
  if (observations !== undefined) {
    for (const obs of observations) {
      if (NON_SEMANTIC_BLOCKER_OBSERVATIONS.has(obs)) {
        return true;
      }
    }
  }
  return false;
}

export function hasStructuralDiagnostic(
  diagnostics: readonly ParserDiagnosticFinding[]
): boolean {
  for (const d of diagnostics) {
    if (STRUCTURAL_DIAGNOSTIC_CODES.has(d.code)) {
      return true;
    }
  }
  return false;
}

interface InternalDiagnosticEntry {
  readonly finding: ParserDiagnosticFinding;
  readonly guidance: string;
}

/**
 * Deterministically analyzes source failure code, local failure message, and observations
 * to produce authoritative local diagnostic findings and guidance.
 *
 * CRITICAL SAFETY REQUIREMENT:
 * Raw failureMessage is strictly matched using bounded deterministic equality or prefixes.
 * It is NEVER interpolated or echoed into diagnostic details or guidance.
 */
export function generateDeterministicDiagnostics(options: {
  failureCode?: ParserRecoveryFailureCode | undefined;
  failureMessage?: string | undefined;
  observations?: readonly ParserRecoveryObservation[] | undefined;
}): {
  diagnostics: readonly ParserDiagnosticFinding[];
  recoveryGuidance: readonly string[];
} {
  const { failureCode, failureMessage, observations = [] } = options;
  const entries: InternalDiagnosticEntry[] = [];
  const seenCodes = new Set<ParserDiagnosticCode>();

  function addEntry(finding: ParserDiagnosticFinding, guidance: string): void {
    if (!seenCodes.has(finding.code)) {
      seenCodes.add(finding.code);
      entries.push({ finding, guidance });
    }
  }

  // 1. Analyze failureCode
  if (failureCode !== undefined) {
    switch (failureCode) {
      case "INVALID_SOURCE_URL":
        addEntry(
          {
            code: "DIAG_INVALID_SOURCE_URL",
            severity: "CRITICAL",
            details: "Previously captured source URL parsing or format validation failure.",
          },
          "Verify the JakMall source URL format. Target host must be jakmall.com or www.jakmall.com."
        );
        break;

      case "SSRF_BLOCKED":
        addEntry(
          {
            code: "DIAG_SSRF_BLOCKED",
            severity: "CRITICAL",
            details: "Request blocked by SSRF filter allowlist or protocol validation.",
          },
          "Request blocked by SSRF filter. Verify host allowlist and HTTP/HTTPS protocol."
        );
        break;

      case "SOURCE_RATE_LIMITED":
        addEntry(
          {
            code: "DIAG_RATE_LIMITED",
            severity: "HIGH",
            details: "JakMall source returned HTTP 429 rate limit.",
          },
          "Source rate limit encountered (HTTP 429). Review the upstream retry/backoff policy outside Phase 5D before retrying the source request."
        );
        break;

      case "PRODUCT_NOT_FOUND":
        addEntry(
          {
            code: "DIAG_PRODUCT_NOT_FOUND",
            severity: "HIGH",
            details: "JakMall source returned HTTP 404 product not found.",
          },
          "Product not found on JakMall (HTTP 404). Verify the JakMall source URL and product existence manually."
        );
        break;

      case "SOURCE_FETCH_FAILED": {
        const isTimeout =
          (failureMessage !== undefined && failureMessage.startsWith("Request timeout after ")) ||
          observations.includes("FETCH_TIMEOUT_OBSERVED");

        if (isTimeout) {
          addEntry(
            {
              code: "DIAG_NETWORK_TIMEOUT",
              severity: "HIGH",
              details: "Network request timed out while fetching product HTML.",
            },
            "Network request timed out while fetching product HTML. Inspect the upstream fetch error/status and network connectivity. Retry policy remains outside Phase 5D."
          );
        } else {
          addEntry(
            {
              code: "DIAG_SOURCE_FETCH_FAILED",
              severity: "HIGH",
              details: "Source HTTP or network fetch failed.",
            },
            "Source HTTP/network fetch failed. Inspect the upstream fetch error/status and network connectivity. Retry policy remains outside Phase 5D."
          );
        }
        break;
      }

      case "TITLE_NOT_FOUND":
        addEntry(
          {
            code: "DIAG_PRODUCT_TITLE_MISSING",
            severity: "HIGH",
            details: "Product title selector returned empty or title was not present in HTML.",
          },
          "Product title selector returned empty. Inspect whether page layout or title selector changed."
        );
        break;

      case "EXTRACTION_VALIDATION_FAILED":
        addEntry(
          {
            code: "DIAG_SPDT_SCHEMA_MISMATCH",
            severity: "HIGH",
            details: "Embedded spdt JavaScript object failed Zod schema validation.",
          },
          "Embedded spdt JavaScript object schema mismatch. Compare against known schema fixture."
        );
        break;

      case "EXTRACTION_FAILED": {
        const isJsonLdMissing =
          failureMessage === "Neither spdt embedded state nor valid JSON-LD found in HTML";

        const isJsonLdPriceInvalid =
          failureMessage === "JSON-LD fallback lacks valid positive price";

        if (isJsonLdMissing) {
          addEntry(
            {
              code: "DIAG_JSON_LD_PRODUCT_MISSING",
              severity: "CRITICAL",
              details: "Neither embedded spdt state nor fallback JSON-LD Product schema found in HTML.",
            },
            "Neither embedded spdt state nor fallback JSON-LD Product found. Inspect page HTML structure."
          );
        } else if (isJsonLdPriceInvalid) {
          addEntry(
            {
              code: "DIAG_JSON_LD_PRICE_INVALID",
              severity: "HIGH",
              details: "Fallback JSON-LD schema was present but offers lacked a valid positive price.",
            },
            "JSON-LD schema was present but offers lacked a valid positive price. Inspect JSON-LD offers structure."
          );
        } else {
          addEntry(
            {
              code: "DIAG_EXTRACTION_FAILED_UNKNOWN",
              severity: "HIGH",
              details: "HTML extraction failed without identified cause.",
            },
            "Extraction failed without specific identified cause. Inspect HTML for structural changes."
          );
        }
        break;
      }

      case "MISSING_PRICE":
        addEntry(
          {
            code: "DIAG_AUTHORITATIVE_PRICE_MISSING",
            severity: "CRITICAL",
            details: "SKU variant is missing authoritative final price in source state.",
          },
          "Inspect authoritative source price.final and source schema. Do not fabricate or substitute a price."
        );
        break;

      case "INVALID_PRICE":
        addEntry(
          {
            code: "DIAG_AUTHORITATIVE_PRICE_INVALID",
            severity: "CRITICAL",
            details: "SKU final price is non-positive or not a valid number.",
          },
          "Inspect authoritative source price.final representation and schema. Do not coerce an invalid/non-positive source price into a replacement selling price."
        );
        break;
    }
  }

  // 2. Analyze observations
  for (const obs of observations) {
    switch (obs) {
      case "SPDT_SCRIPT_MISSING_OBSERVED":
        addEntry(
          {
            code: "DIAG_SPDT_SCRIPT_MISSING_OBSERVED",
            severity: "CRITICAL",
            details: "Observed that HTML contains no script tag declaring var spdt.",
          },
          "HTML contains no <script> element with var spdt. Verify whether script name or page rendering changed."
        );
        break;

      case "SPDT_SYNTAX_FAILURE_OBSERVED":
        addEntry(
          {
            code: "DIAG_SPDT_SYNTAX_FAILURE_OBSERVED",
            severity: "HIGH",
            details: "Observed that script with var spdt exists but balanced object extraction or JSON parsing failed.",
          },
          "Script containing var spdt exists but object extraction or JSON parsing failed. Inspect script syntax."
        );
        break;

      case "JSON_LD_PRODUCT_MISSING_OBSERVED":
        addEntry(
          {
            code: "DIAG_JSON_LD_PRODUCT_MISSING",
            severity: "CRITICAL",
            details: "Observed that fallback JSON-LD Product schema is missing.",
          },
          "Inspect whether the JSON-LD Product fallback structure changed or is absent."
        );
        break;

      case "JSON_LD_PRICE_INVALID_OBSERVED":
        addEntry(
          {
            code: "DIAG_JSON_LD_PRICE_INVALID",
            severity: "HIGH",
            details: "Observed that fallback JSON-LD Product schema lacks valid positive price.",
          },
          "Inspect whether the JSON-LD fallback offers structure or price representation changed."
        );
        break;

      case "SKU_RECORD_EMPTY_OBSERVED":
        addEntry(
          {
            code: "DIAG_SKU_RECORD_EMPTY_OBSERVED",
            severity: "HIGH",
            details: "Observed that spdt.sku record contains 0 SKU entries.",
          },
          "Product spdt.sku record contains 0 SKU entries. Inspect variant options and matrix structure."
        );
        break;

      case "FETCH_TIMEOUT_OBSERVED":
        addEntry(
          {
            code: "DIAG_NETWORK_TIMEOUT",
            severity: "HIGH",
            details: "Network request timed out while fetching product HTML.",
          },
          "Network request timed out while fetching product HTML. Inspect the upstream fetch error/status and network connectivity. Retry policy remains outside Phase 5D."
        );
        break;
    }
  }

  // Stable sort by diagnostic code using UTF-16 code-unit comparator
  entries.sort((a, b) =>
    a.finding.code < b.finding.code ? -1 : a.finding.code > b.finding.code ? 1 : 0
  );

  // Apply local bounds
  const cappedEntries = entries.slice(0, PARSER_RECOVERY_BOUNDS.MAX_DIAGNOSTICS_COUNT);

  const diagnostics = cappedEntries.map((e) => e.finding);

  // Collect unique guidance strings in stable order
  const seenGuidance = new Set<string>();
  const recoveryGuidance: string[] = [];

  for (const entry of cappedEntries) {
    if (!seenGuidance.has(entry.guidance)) {
      seenGuidance.add(entry.guidance);
      recoveryGuidance.push(entry.guidance);
      if (recoveryGuidance.length >= PARSER_RECOVERY_BOUNDS.MAX_GUIDANCE_COUNT) {
        break;
      }
    }
  }

  return {
    diagnostics,
    recoveryGuidance,
  };
}
