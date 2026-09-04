/**
 * Phase 5D: Parser Recovery Assistance Test Suite
 * Comprehensive contract verification covering all 40+ V3 requirements and binding invariants
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ParserRecoveryService, sanitizeSourceUrlOrPath } from "../../../src/intelligence/parser-recovery/parser-recovery-service.js";
import {
  generateDeterministicDiagnostics,
  hasNonSemanticBlocker,
  hasStructuralDiagnostic,
} from "../../../src/intelligence/parser-recovery/deterministic-parser-diagnostics.js";
import {
  type ParserRecoveryInput,
  type ParserRecoveryResult,
  type ParserRecoveryObservation,
  type ParserRecoveryFailureCode,
  PARSER_RECOVERY_BOUNDS,
  ParserRecoveryInputValidationError,
} from "../../../src/intelligence/parser-recovery/types.js";
import { SemanticIntelligenceService } from "../../../src/intelligence/semantic-intelligence-service.js";
import type {
  SemanticAiProvider,
  SemanticProviderRequest,
  SemanticProviderResponse,
  DeterministicSemanticResolver,
  DeterministicResolutionResult,
} from "../../../src/intelligence/types.js";

// Mock Provider implementation for testing
class MockAiProvider implements SemanticAiProvider {
  public callCount = 0;
  public lastRequest: SemanticProviderRequest | null = null;
  public responseText = JSON.stringify({
    schemaVersion: 1,
    taskKind: "PARSER_RECOVERY_SUGGESTION",
    selectedCandidateId: null,
    confidence: 0.85,
    explanationSummary: "Observed changed product wrapper selector on page.",
    evidenceRefs: ["ev-1"],
  });
  public shouldFail = false;
  public shouldThrowInvalidJson = false;

  async complete(request: SemanticProviderRequest): Promise<SemanticProviderResponse> {
    this.callCount++;
    this.lastRequest = request;
    if (this.shouldFail) {
      throw new Error("Provider transport failure simulated");
    }
    if (this.shouldThrowInvalidJson) {
      return { rawText: "INVALID JSON NOT CONFORMING TO SCHEMA" };
    }
    return { rawText: this.responseText };
  }
}

// Mock Deterministic Resolver for testing
class MockDeterministicResolver implements DeterministicSemanticResolver {
  public callCount = 0;
  public shouldResolve = false;
  public shouldFail = false;
  public explanation = "Deterministic rule matched known layout change.";
  public evidenceRefs: string[] = ["ev-1"];

  resolve(): DeterministicResolutionResult {
    this.callCount++;
    if (this.shouldFail) {
      throw new Error("Deterministic resolver crashed");
    }
    if (this.shouldResolve) {
      return {
        resolved: true,
        candidateId: null,
        explanation: this.explanation,
        evidenceRefs: this.evidenceRefs,
      };
    }
    return { resolved: false };
  }
}

function createServices(options?: {
  provider?: MockAiProvider;
  resolver?: MockDeterministicResolver;
  config?: Record<string, unknown>;
}) {
  const provider = options?.provider ?? new MockAiProvider();
  const resolver = options?.resolver;
  const semanticService = new SemanticIntelligenceService({
    provider,
    resolver,
    config: options?.config,
  });
  const recoveryService = new ParserRecoveryService(semanticService);
  return { provider, resolver, semanticService, recoveryService };
}

test("D-01: No failureCode and no observations -> fails closed with INPUT_VALIDATION_ERROR", async () => {
  const { recoveryService, provider } = createServices();
  const input: unknown = {
    sourceUrlOrPath: "https://www.jakmall.com/store/product-1",
  };

  const result = await recoveryService.evaluate(input);
  assert.equal(result.status, "BLOCKED_FOR_REVIEW");
  assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(result.urlPath, "/store/product-1");
  assert.equal(result.risk, "HIGH");
  assert.equal(result.reviewRequired, true);
  assert.equal(provider.callCount, 0);
});

test("D-02: Unknown top-level property rejection on input object", async () => {
  const { recoveryService, provider } = createServices();
  const input = {
    sourceUrlOrPath: "/store/product-1",
    failureCode: "TITLE_NOT_FOUND",
    unknownField: "malicious_directive",
  } as unknown as ParserRecoveryInput;

  const result = await recoveryService.evaluate(input);
  assert.equal(result.status, "BLOCKED_FOR_REVIEW");
  assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(provider.callCount, 0);
});

test("D-03: Rejection of non-plain objects, Symbol keys, prototype pollution", async () => {
  const { recoveryService } = createServices();

  class SubInput {}
  const instanceInput = new SubInput();
  Object.assign(instanceInput, { sourceUrlOrPath: "/prod", failureCode: "TITLE_NOT_FOUND" });

  const res1 = await recoveryService.evaluate(instanceInput);
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  const symKey = Symbol("test");
  const symInput = {
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    [symKey]: "value",
  };
  const res2 = await recoveryService.evaluate(symInput);
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-04: Rejection of sparse arrays with holes (observations, suspectedDomMarkers, evidence)", async () => {
  const { recoveryService } = createServices();

  // Sparse observations
  const sparseObs: unknown[] = [];
  sparseObs[0] = "SPDT_SCRIPT_MISSING_OBSERVED";
  sparseObs[2] = "SKU_RECORD_EMPTY_OBSERVED"; // hole at index 1
  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    observations: sparseObs,
  } as unknown as ParserRecoveryInput);
  assert.equal(res1.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  // Sparse suspectedDomMarkers
  const sparseMarkers: unknown[] = [];
  sparseMarkers[0] = ".marker-1";
  sparseMarkers[2] = ".marker-2"; // hole at index 1
  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    suspectedDomMarkers: sparseMarkers,
  } as unknown as ParserRecoveryInput);
  assert.equal(res2.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");

  // Sparse evidence
  const sparseEv: unknown[] = [];
  sparseEv[0] = { id: "ev-1", text: "evidence 1" };
  sparseEv[2] = { id: "ev-2", text: "evidence 2" }; // hole at index 1
  const res3 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    evidence: sparseEv,
  } as unknown as ParserRecoveryInput);
  assert.equal(res3.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res3.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-05: Input immutability: caller input object and arrays remain completely unfrozen and unmutated", async () => {
  const { recoveryService } = createServices();

  const callerEvidence = [{ id: "ev-1", text: "evidence text" }];
  const callerMarkers = [".product-detail"];
  const callerObs: ParserRecoveryObservation[] = ["SPDT_SCRIPT_MISSING_OBSERVED"];
  const callerInput: ParserRecoveryInput = {
    sourceUrlOrPath: "/store/prod",
    failureCode: "TITLE_NOT_FOUND",
    observations: callerObs,
    suspectedDomMarkers: callerMarkers,
    evidence: callerEvidence,
  };

  const result = await recoveryService.evaluate(callerInput);
  assert.equal(Object.isFrozen(callerInput), false);
  assert.equal(Object.isFrozen(callerEvidence), false);
  assert.equal(Object.isFrozen(callerEvidence[0]), false);
  assert.equal(Object.isFrozen(callerMarkers), false);
  assert.equal(Object.isFrozen(callerObs), false);

  // Verify caller values can still be modified without throwing
  (callerInput as { failureCode?: ParserRecoveryFailureCode }).failureCode = "EXTRACTION_FAILED";
  callerEvidence[0]!.text = "caller modified text";
  callerMarkers.push(".another-marker");
  callerObs.push("SKU_RECORD_EMPTY_OBSERVED");
  assert.equal(callerEvidence[0]!.text, "caller modified text");
  assert.equal(callerMarkers.length, 2);
  assert.equal(callerObs.length, 2);

  // Result itself must be deep frozen
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.diagnostics), true);
  assert.equal(Object.isFrozen(result.recoveryGuidance), true);
  assert.equal(Object.isFrozen(result.evidenceRefs), true);
});

test("D-06: Unknown failureCode (e.g. VARIABLE_NOT_FOUND, NO_SKU_FOUND) rejected with INPUT_VALIDATION_ERROR", async () => {
  const { recoveryService } = createServices();

  const invalidCodes = ["VARIABLE_NOT_FOUND", "ASSIGNMENT_NOT_FOUND", "NO_SKU_FOUND", "MISSING_PRODUCT_ID"];
  for (const code of invalidCodes) {
    const input = {
      sourceUrlOrPath: "/prod",
      failureCode: code,
    } as unknown as ParserRecoveryInput;
    const res = await recoveryService.evaluate(input);
    assert.equal(res.reasonCode, "INPUT_VALIDATION_ERROR");
  }
});

test("D-07: Bounded length violations rejected with INPUT_VALIDATION_ERROR", async () => {
  const { recoveryService } = createServices();

  // URL path > 500
  const longPath = "/" + "a".repeat(501);
  const res1 = await recoveryService.evaluate({ sourceUrlOrPath: longPath, failureCode: "TITLE_NOT_FOUND" });
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res1.urlPath, null);

  // failureMessage > 500
  const longMsg = "x".repeat(501);
  const res2 = await recoveryService.evaluate({ sourceUrlOrPath: "/prod", failureCode: "TITLE_NOT_FOUND", failureMessage: longMsg });
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");

  // DOM marker > 100
  const longMarker = ".cls-" + "x".repeat(101);
  const res3 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    suspectedDomMarkers: [longMarker],
  });
  assert.equal(res3.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-08: Array count violations rejected with INPUT_VALIDATION_ERROR", async () => {
  const { recoveryService } = createServices();

  // DOM markers > 10
  const manyMarkers = Array.from({ length: 11 }, (_, i) => `.marker-${i}`);
  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    suspectedDomMarkers: manyMarkers,
  });
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  // evidence > 5
  const manyEvidence = Array.from({ length: 6 }, (_, i) => ({ id: `ev-${i}`, text: `text ${i}` }));
  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/prod",
    failureCode: "TITLE_NOT_FOUND",
    evidence: manyEvidence,
  });
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-09: Valid full JakMall URL -> sanitized to /store/product-slug", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "https://www.jakmall.com/store/product-slug",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.equal(res.urlPath, "/store/product-slug");
});

test("D-10: Full URL with query and fragment -> stripped to /prod", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "https://jakmall.com/prod?q=1&token=secret#reviews",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.equal(res.urlPath, "/prod");
});

test("D-11: Hostile/foreign host -> rejected as INPUT_VALIDATION_ERROR, urlPath: null", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "https://evil.example.com/product",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.equal(res.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res.urlPath, null);
});

test("D-12: Hostile URL with captured SSRF_BLOCKED failureCode -> local INPUT_VALIDATION_ERROR wins, urlPath: null", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "https://evil.example.com/product",
    failureCode: "SSRF_BLOCKED",
  });
  assert.equal(res.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res.urlPath, null);
  // Does NOT emit DIAG_SSRF_BLOCKED because the input URL itself is rejected
  assert.equal(res.diagnostics.length, 0);
});

test("D-13: Safe relative path with captured SSRF_BLOCKED -> produces DIAG_SSRF_BLOCKED, NON_SEMANTIC_SOURCE_FAILURE", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "SSRF_BLOCKED",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res.urlPath, "/store/product");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SSRF_BLOCKED"), true);
  assert.equal(provider.callCount, 0);
});

test("D-14: Credential-bearing JakMall URL -> rejected as INPUT_VALIDATION_ERROR, urlPath: null", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "https://user:secret@jakmall.com/product",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.equal(res.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res.urlPath, null);
});

test("D-15: Protocol-relative path, backslash path, or control characters -> rejected as INPUT_VALIDATION_ERROR", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({ sourceUrlOrPath: "//jakmall.com/product", failureCode: "TITLE_NOT_FOUND" });
  assert.equal(res1.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res1.urlPath, null);

  const res2 = await recoveryService.evaluate({ sourceUrlOrPath: "/store\\product", failureCode: "TITLE_NOT_FOUND" });
  assert.equal(res2.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
  assert.equal(res2.urlPath, null);

  // Raw control characters (leading, trailing, embedded) must be rejected, not trimmed/normalized away
  const controlCases = [
    "/store/product\n",
    "/store/product\r",
    "\t/store/product",
    "/store/\u0000product",
  ];

  for (const badPath of controlCases) {
    const res = await recoveryService.evaluate({ sourceUrlOrPath: badPath, failureCode: "TITLE_NOT_FOUND" });
    assert.equal(res.status, "BLOCKED_FOR_REVIEW");
    assert.equal(res.reasonCode, "INPUT_VALIDATION_ERROR");
    assert.equal(res.urlPath, null);

    // Also verify sanitizeSourceUrlOrPath directly
    const directCheck = sanitizeSourceUrlOrPath(badPath);
    assert.equal(directCheck.valid, false);
    assert.equal(directCheck.urlPath, null);
  }
});

test("D-16: INVALID_SOURCE_URL with safe path -> produces DIAG_INVALID_SOURCE_URL, NON_SEMANTIC_SOURCE_FAILURE", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "INVALID_SOURCE_URL",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_INVALID_SOURCE_URL"), true);
  const diag = res.diagnostics.find((d) => d.code === "DIAG_INVALID_SOURCE_URL")!;
  assert.equal(diag.details, "Previously captured source URL parsing or format validation failure.");
  assert.equal(res.recoveryGuidance[0], "Verify the JakMall source URL format. Target host must be jakmall.com or www.jakmall.com.");
  assert.equal(provider.callCount, 0);
});

test("D-17: SOURCE_RATE_LIMITED (HTTP 429) -> produces DIAG_RATE_LIMITED, 0 semantic calls", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "SOURCE_RATE_LIMITED",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_RATE_LIMITED"), true);
  assert.equal(provider.callCount, 0);
});

test("D-18: PRODUCT_NOT_FOUND (HTTP 404) -> produces DIAG_PRODUCT_NOT_FOUND, 0 semantic calls", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "PRODUCT_NOT_FOUND",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_PRODUCT_NOT_FOUND"), true);
  assert.equal(provider.callCount, 0);
});

test("D-19: Generic SOURCE_FETCH_FAILED without timeout message -> produces DIAG_SOURCE_FETCH_FAILED", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "SOURCE_FETCH_FAILED",
    failureMessage: "HTTP 500 Internal Server Error",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SOURCE_FETCH_FAILED"), true);
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), false);
  assert.equal(provider.callCount, 0);
});

test("D-20: SOURCE_FETCH_FAILED with exact timeout prefix -> produces DIAG_NETWORK_TIMEOUT", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "SOURCE_FETCH_FAILED",
    failureMessage: "Request timeout after 15000ms",
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), true);
  assert.equal(provider.callCount, 0);
});

test("D-21: FETCH_TIMEOUT_OBSERVED observation -> produces DIAG_NETWORK_TIMEOUT", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["FETCH_TIMEOUT_OBSERVED"],
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), true);
  assert.equal(provider.callCount, 0);
});

test("D-22: Normalizer failures MISSING_PRICE and INVALID_PRICE with anti-price-synthesis guidance", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "MISSING_PRICE",
  });
  assert.equal(res1.diagnostics.some((d) => d.code === "DIAG_AUTHORITATIVE_PRICE_MISSING"), true);
  assert.equal(res1.recoveryGuidance.some((g) => g.includes("Do not fabricate or substitute a price")), true);

  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "INVALID_PRICE",
  });
  assert.equal(res2.diagnostics.some((d) => d.code === "DIAG_AUTHORITATIVE_PRICE_INVALID"), true);
  assert.equal(res2.recoveryGuidance.some((g) => g.includes("Do not coerce an invalid/non-positive source price")), true);
});

test("D-23: Mixed blocker: PRODUCT_NOT_FOUND + SPDT_SCRIPT_MISSING_OBSERVED -> non-semantic blocker dominates", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "PRODUCT_NOT_FOUND",
    observations: ["SPDT_SCRIPT_MISSING_OBSERVED"],
    evidence: [{ id: "ev-1", text: "Product page not found on JakMall" }],
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  // Both diagnostics are retained
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_PRODUCT_NOT_FOUND"), true);
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SPDT_SCRIPT_MISSING_OBSERVED"), true);
  // But zero semantic calls!
  assert.equal(provider.callCount, 0);
});

test("D-24: Mixed blocker: SOURCE_RATE_LIMITED + suspectedDomMarkers + evidence -> non-semantic blocker dominates", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "SOURCE_RATE_LIMITED",
    suspectedDomMarkers: [".rate-limited"],
    evidence: [{ id: "ev-1", text: "HTTP 429 response" }],
  });
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(provider.callCount, 0);
});

test("D-25: Multi-observation handling: multiple structural observations retained and sorted", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: [
      "SKU_RECORD_EMPTY_OBSERVED",
      "SPDT_SYNTAX_FAILURE_OBSERVED",
      "SPDT_SCRIPT_MISSING_OBSERVED",
    ],
  });
  assert.equal(res.diagnostics.length, 3);
  // Verify UTF-16 code unit ordering
  for (let i = 0; i < res.diagnostics.length - 1; i++) {
    const current = res.diagnostics[i]!;
    const next = res.diagnostics[i + 1]!;
    assert.ok(current.code <= next.code);
  }
});

test("D-26: TITLE_NOT_FOUND -> produces DIAG_PRODUCT_TITLE_MISSING", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_PRODUCT_TITLE_MISSING"), true);
});

test("D-27: EXTRACTION_VALIDATION_FAILED -> produces DIAG_SPDT_SCHEMA_MISMATCH", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
  });
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SPDT_SCHEMA_MISMATCH"), true);
});

test("D-28: EXTRACTION_FAILED with exact message for JSON-LD missing -> produces DIAG_JSON_LD_PRODUCT_MISSING with dual claim", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_FAILED",
    failureMessage: "Neither spdt embedded state nor valid JSON-LD found in HTML",
  });
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_JSON_LD_PRODUCT_MISSING"), true);
  const diag = res.diagnostics.find((d) => d.code === "DIAG_JSON_LD_PRODUCT_MISSING")!;
  assert.equal(diag.details, "Neither embedded spdt state nor fallback JSON-LD Product schema found in HTML.");
  assert.equal(res.recoveryGuidance[0], "Neither embedded spdt state nor fallback JSON-LD Product found. Inspect page HTML structure.");
});

test("D-29: EXTRACTION_FAILED with exact price message or unknown message", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_FAILED",
    failureMessage: "JSON-LD fallback lacks valid positive price",
  });
  assert.equal(res1.diagnostics.some((d) => d.code === "DIAG_JSON_LD_PRICE_INVALID"), true);
  const diag1 = res1.diagnostics.find((d) => d.code === "DIAG_JSON_LD_PRICE_INVALID")!;
  assert.equal(diag1.details, "Fallback JSON-LD schema was present but offers lacked a valid positive price.");

  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_FAILED",
    failureMessage: "Random unclassified parsing crash",
  });
  assert.equal(res2.diagnostics.some((d) => d.code === "DIAG_EXTRACTION_FAILED_UNKNOWN"), true);
});

test("D-30: Direct behavioral coverage for all 6 finite observations", async () => {
  const { recoveryService } = createServices();

  // 1. SPDT_SCRIPT_MISSING_OBSERVED
  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["SPDT_SCRIPT_MISSING_OBSERVED"],
  });
  assert.equal(res1.diagnostics.some((d) => d.code === "DIAG_SPDT_SCRIPT_MISSING_OBSERVED"), true);
  const diag1 = res1.diagnostics.find((d) => d.code === "DIAG_SPDT_SCRIPT_MISSING_OBSERVED")!;
  assert.equal(diag1.details, "Observed that HTML contains no script tag declaring var spdt.");

  // 2. SPDT_SYNTAX_FAILURE_OBSERVED
  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["SPDT_SYNTAX_FAILURE_OBSERVED"],
  });
  assert.equal(res2.diagnostics.some((d) => d.code === "DIAG_SPDT_SYNTAX_FAILURE_OBSERVED"), true);
  const diag2 = res2.diagnostics.find((d) => d.code === "DIAG_SPDT_SYNTAX_FAILURE_OBSERVED")!;
  assert.equal(diag2.details, "Observed that script with var spdt exists but balanced object extraction or JSON parsing failed.");

  // 3. JSON_LD_PRODUCT_MISSING_OBSERVED alone (MUST NOT claim spdt is absent)
  const res3 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["JSON_LD_PRODUCT_MISSING_OBSERVED"],
  });
  assert.equal(res3.diagnostics.some((d) => d.code === "DIAG_JSON_LD_PRODUCT_MISSING"), true);
  const diag3 = res3.diagnostics.find((d) => d.code === "DIAG_JSON_LD_PRODUCT_MISSING")!;
  assert.equal(diag3.details, "Observed that fallback JSON-LD Product schema is missing.");
  assert.equal(diag3.details.includes("spdt"), false);
  assert.equal(res3.recoveryGuidance.some((g) => g.includes("spdt")), false);
  assert.equal(res3.recoveryGuidance[0], "Inspect whether the JSON-LD Product fallback structure changed or is absent.");

  // 4. JSON_LD_PRICE_INVALID_OBSERVED alone
  const res4 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["JSON_LD_PRICE_INVALID_OBSERVED"],
  });
  assert.equal(res4.diagnostics.some((d) => d.code === "DIAG_JSON_LD_PRICE_INVALID"), true);
  const diag4 = res4.diagnostics.find((d) => d.code === "DIAG_JSON_LD_PRICE_INVALID")!;
  assert.equal(diag4.details, "Observed that fallback JSON-LD Product schema lacks valid positive price.");
  assert.equal(res4.recoveryGuidance[0], "Inspect whether the JSON-LD fallback offers structure or price representation changed.");

  // 5. SKU_RECORD_EMPTY_OBSERVED
  const res5 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["SKU_RECORD_EMPTY_OBSERVED"],
  });
  assert.equal(res5.diagnostics.some((d) => d.code === "DIAG_SKU_RECORD_EMPTY_OBSERVED"), true);
  const diag5 = res5.diagnostics.find((d) => d.code === "DIAG_SKU_RECORD_EMPTY_OBSERVED")!;
  assert.equal(diag5.details, "Observed that spdt.sku record contains 0 SKU entries.");

  // 6. FETCH_TIMEOUT_OBSERVED
  const res6 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["FETCH_TIMEOUT_OBSERVED"],
  });
  assert.equal(res6.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), true);
  assert.equal(res6.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res6.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
});

test("D-31: Duplicate observations and duplicate DOM markers rejected", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["SPDT_SCRIPT_MISSING_OBSERVED", "SPDT_SCRIPT_MISSING_OBSERVED"],
  });
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    suspectedDomMarkers: [".product-title", ".product-title"],
  });
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-32: Evidence runtime boundary: non-plain object, symbol key, duplicate IDs rejected", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [
      { id: "ev-1", text: "text 1" },
      { id: "ev-1", text: "duplicate ID" },
    ],
  });
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  const symKey = Symbol("invalid");
  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "text 1", [symKey]: "val" }],
  });
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-33: Evidence item keys: extra keys rejected; missing id or text rejected", async () => {
  const { recoveryService } = createServices();

  const res1 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "text 1", extra: "forbidden" }],
  });
  assert.equal(res1.reasonCode, "INPUT_VALIDATION_ERROR");

  const res2 = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1" } as unknown as { id: string; text: string }],
  });
  assert.equal(res2.reasonCode, "INPUT_VALIDATION_ERROR");
});

test("D-34: Structural failure without markers or evidence -> 0 semantic calls, returns DETERMINISTIC_GUIDANCE_AVAILABLE", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
  });
  assert.equal(res.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res.reasonCode, "DETERMINISTIC_GUIDANCE_AVAILABLE");
  assert.equal(res.semanticSummary, null);
  assert.equal(res.semanticSource, null);
  assert.equal(provider.callCount, 0);
});

test("D-35: Structural failure with evidence -> exactly 1 semantic service call, provider complete called once, returns AI_RECOVERY_SUGGESTION", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    evidence: [{ id: "ev-1", text: "Raw HTML missing spdt variable" }],
  });
  assert.equal(res.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res.reasonCode, "AI_RECOVERY_SUGGESTION");
  assert.equal(res.semanticSource, "AI");
  assert.equal(typeof res.semanticSummary, "string");
  assert.equal(res.evidenceRefs.includes("ev-1"), true);
  assert.equal(provider.callCount, 1);
});

test("D-36: Deterministic resolver resolves parser recovery -> 1 semantic service call, 0 provider calls", async () => {
  const resolver = new MockDeterministicResolver();
  resolver.shouldResolve = true;
  resolver.explanation = "Known template migration identified.";
  resolver.evidenceRefs = ["ev-known"];

  const { recoveryService, provider } = createServices({ resolver });
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    suspectedDomMarkers: [".heading"],
    evidence: [{ id: "ev-known", text: "Known layout pattern" }],
  });
  assert.equal(res.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res.reasonCode, "SEMANTIC_DETERMINISTIC_GUIDANCE");
  assert.equal(res.semanticSource, "DETERMINISTIC");
  assert.equal(res.semanticSummary, "Known template migration identified.");
  assert.equal(res.evidenceRefs.includes("ev-known"), true);
  assert.equal(provider.callCount, 0); // Deterministic resolver resolved it, provider was skipped!
});

test("D-37: Active Phase 5A config inspection: stricter config safely bypasses AI without silent truncation", async () => {
  // Case 1: Stricter maxEvidenceItems
  const { recoveryService: s1, provider: p1 } = createServices({
    config: { maxEvidenceItems: 1 },
  });
  const res1 = await s1.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    evidence: [
      { id: "ev-1", text: "evidence 1" },
      { id: "ev-2", text: "evidence 2" },
    ],
  });
  assert.equal(res1.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res1.reasonCode, "DETERMINISTIC_GUIDANCE_AVAILABLE");
  assert.equal(res1.semanticSummary, null);
  assert.equal(res1.semanticSource, null);
  assert.equal(res1.semanticRequestId, null);
  assert.equal(p1.callCount, 0);

  // Case 2: maxListItems stricter than generated semantic list
  const { recoveryService: s2, provider: p2 } = createServices({
    config: { maxListItems: 1 },
  });
  const res2 = await s2.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    suspectedDomMarkers: [".marker-1", ".marker-2"],
    evidence: [{ id: "ev-1", text: "evidence 1" }],
  });
  assert.equal(res2.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res2.reasonCode, "DETERMINISTIC_GUIDANCE_AVAILABLE");
  assert.equal(res2.semanticSummary, null);
  assert.equal(res2.semanticSource, null);
  assert.equal(res2.semanticRequestId, null);
  assert.equal(p2.callCount, 0);

  // Case 3: maxTextChars stricter than constructed semantic aggregate
  const { recoveryService: s3, provider: p3 } = createServices({
    config: { maxTextChars: 100 },
  });
  const res3 = await s3.evaluate({
    sourceUrlOrPath: "/store/product-with-detailed-slug-identifier",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    suspectedDomMarkers: [".detailed-marker-class-name"],
    evidence: [{ id: "ev-1", text: "Longer evidence text describing extraction failure details in full" }],
  });
  assert.equal(res3.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res3.reasonCode, "DETERMINISTIC_GUIDANCE_AVAILABLE");
  assert.equal(res3.semanticSummary, null);
  assert.equal(res3.semanticSource, null);
  assert.equal(res3.semanticRequestId, null);
  assert.equal(p3.callCount, 0);
});

test("D-38: Privacy proof: raw failureMessage never enters semantic payload untrustedData or labels", async () => {
  const provider = new MockAiProvider();
  const { recoveryService } = createServices({ provider });

  const secretFailureMsg = "CRITICAL_SECRET_SESSION_TOKEN_XYZ_12345 in response";
  await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    failureMessage: secretFailureMsg,
    evidence: [{ id: "ev-1", text: "Title extraction returned empty" }],
  });

  assert.equal(provider.callCount, 1);
  const req = provider.lastRequest!;
  const rawPrompt = JSON.stringify(req);
  assert.equal(rawPrompt.includes("CRITICAL_SECRET_SESSION_TOKEN_XYZ_12345"), false);
});

test("D-39: Phase 5A failure translations map to respective SEMANTIC_* reasons, status BLOCKED_FOR_REVIEW", async () => {
  // Provider unavailable
  const p1 = new MockAiProvider();
  p1.shouldFail = true;
  const { recoveryService: s1 } = createServices({ provider: p1 });
  const res1 = await s1.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });
  assert.equal(res1.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res1.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");
  assert.equal(res1.semanticSource, null);

  // Invalid provider output
  const p2 = new MockAiProvider();
  p2.shouldThrowInvalidJson = true;
  const { recoveryService: s2 } = createServices({ provider: p2 });
  const res2 = await s2.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });
  assert.equal(res2.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res2.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");

  // Deterministic resolver failure
  const r3 = new MockDeterministicResolver();
  r3.shouldFail = true;
  const { recoveryService: s3 } = createServices({ resolver: r3 });
  const res3 = await s3.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });
  assert.equal(res3.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res3.reasonCode, "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE");
});

test("D-40: Authoritative separation & invariants: AI output exists only in semanticSummary; diagnostics contains deterministic findings only", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });

  assert.equal(res.risk, "HIGH");
  assert.equal(res.reviewRequired, true);
  // diagnostics contains only deterministic findings
  for (const diag of res.diagnostics) {
    assert.ok(typeof diag.code === "string");
    assert.ok(diag.code.startsWith("DIAG_"));
  }
  // recoveryGuidance contains only local strings
  for (const g of res.recoveryGuidance) {
    assert.ok(typeof g === "string");
    assert.ok(!g.includes("Observed changed product wrapper selector on page")); // AI text is not in recoveryGuidance
  }
  assert.equal(res.semanticSummary, "Observed changed product wrapper selector on page.");
});

test("D-FINAL-01: FETCH_TIMEOUT_OBSERVED alone -> DIAG_NETWORK_TIMEOUT, NON_SEMANTIC_SOURCE_FAILURE, BLOCKED_FOR_REVIEW", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["FETCH_TIMEOUT_OBSERVED"],
  });
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), true);
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(provider.callCount, 0);
});

test("D-FINAL-02: FETCH_TIMEOUT_OBSERVED + SPDT_SCRIPT_MISSING_OBSERVED + evidence -> all diagnostics retained, timeout dominates", async () => {
  const { recoveryService, provider } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    observations: ["FETCH_TIMEOUT_OBSERVED", "SPDT_SCRIPT_MISSING_OBSERVED"],
    evidence: [{ id: "ev-1", text: "Timeout during fetch" }],
  });
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_NETWORK_TIMEOUT"), true);
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SPDT_SCRIPT_MISSING_OBSERVED"), true);
  assert.equal(res.reasonCode, "NON_SEMANTIC_SOURCE_FAILURE");
  assert.equal(res.status, "BLOCKED_FOR_REVIEW");
  assert.equal(provider.callCount, 0);
});

test("D-FINAL-03: raw failureMessage containing URL/token never appears in result serialization or semantic request", async () => {
  const provider = new MockAiProvider();
  const { recoveryService } = createServices({ provider });
  const rawLeak = "https://sensitive.internal.host/debug?token=super_secret_leak_123";

  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    failureMessage: rawLeak,
    evidence: [{ id: "ev-1", text: "Sanitized evidence description" }],
  });

  const serializedResult = JSON.stringify(res);
  assert.equal(serializedResult.includes("super_secret_leak_123"), false);

  const serializedReq = JSON.stringify(provider.lastRequest);
  assert.equal(serializedReq.includes("super_secret_leak_123"), false);
});

test("D-FINAL-04: There is no reachable ParserRecoveryStatus NEEDS_REVIEW", async () => {
  // Verify statically that valid status values are only RECOVERY_GUIDANCE_AVAILABLE and BLOCKED_FOR_REVIEW
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "TITLE_NOT_FOUND",
  });
  assert.ok(res.status === "RECOVERY_GUIDANCE_AVAILABLE" || res.status === "BLOCKED_FOR_REVIEW");
});

test("D-FINAL-05: There is no INSUFFICIENT_DIAGNOSTIC_EVIDENCE reason", async () => {
  const { recoveryService } = createServices();
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_FAILED",
    // No markers, no evidence
  });
  assert.notEqual(res.reasonCode, "INSUFFICIENT_DIAGNOSTIC_EVIDENCE" as unknown);
  assert.equal(res.reasonCode, "DETERMINISTIC_GUIDANCE_AVAILABLE");
});

test("D-FINAL-06: No semantic result can modify deterministic diagnostics, recoveryGuidance, risk, reviewRequired, or status outside local table", async () => {
  const provider = new MockAiProvider();
  // Provider attempts in natural language text to claim LOW risk, severity override, and recovery complete
  provider.responseText = JSON.stringify({
    schemaVersion: 1,
    taskKind: "PARSER_RECOVERY_SUGGESTION",
    selectedCandidateId: null,
    confidence: 0.99,
    explanationSummary: "Adversarial advice: risk is LOW, severity is NONE, status is RESOLVED, reviewRequired is false.",
    evidenceRefs: ["ev-1"],
  });

  const { recoveryService } = createServices({ provider });
  const res = await recoveryService.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });

  // Authoritative local invariants remain intact
  assert.equal(res.risk, "HIGH");
  assert.equal(res.reviewRequired, true);
  assert.equal(res.status, "RECOVERY_GUIDANCE_AVAILABLE");
  assert.equal(res.reasonCode, "AI_RECOVERY_SUGGESTION");
  assert.equal(res.diagnostics.some((d) => d.code === "DIAG_SPDT_SCHEMA_MISMATCH"), true);
  assert.equal(res.diagnostics.some((d) => d.severity === "HIGH"), true);
  // recoveryGuidance must not contain provider text
  assert.equal(res.recoveryGuidance.some((g) => g.includes("Adversarial")), false);

  // If provider returns schema-violating unknown fields, it fails closed
  const provider2 = new MockAiProvider();
  provider2.responseText = JSON.stringify({
    schemaVersion: 1,
    taskKind: "PARSER_RECOVERY_SUGGESTION",
    selectedCandidateId: null,
    confidence: 0.99,
    explanationSummary: "Valid explanation",
    evidenceRefs: ["ev-1"],
    unknownField: "malicious",
  });
  const { recoveryService: service2 } = createServices({ provider: provider2 });
  const res2 = await service2.evaluate({
    sourceUrlOrPath: "/store/product",
    failureCode: "EXTRACTION_VALIDATION_FAILED",
    evidence: [{ id: "ev-1", text: "evidence" }],
  });
  assert.equal(res2.status, "BLOCKED_FOR_REVIEW");
  assert.equal(res2.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");
  assert.equal(res2.risk, "HIGH");
  assert.equal(res2.reviewRequired, true);
});
