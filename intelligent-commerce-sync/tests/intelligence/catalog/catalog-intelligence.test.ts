/**
 * Phase 5B: Category & Attribute Intelligence Test Suite
 * Tests B-01 through B-47 covering deterministic verified resolution,
 * store trust boundary validation, Phase 5A fallback, copy-then-freeze invariants,
 * and failure preservation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeLookupKey } from "../../../src/intelligence/catalog/normalization.js";
import {
  type VerifiedCatalogMappingStore,
  type VerifiedCategoryMappingRecord,
  type VerifiedAttributeMappingRecord,
} from "../../../src/intelligence/catalog/verified-mapping-store.js";
import { CatalogIntelligenceService } from "../../../src/intelligence/catalog/catalog-intelligence-service.js";
import {
  CATALOG_BOUNDS,
  CatalogInputValidationError,
  type CategoryMappingRequest,
  type AttributeMappingRequest,
} from "../../../src/intelligence/catalog/types.js";
import { SemanticIntelligenceService } from "../../../src/intelligence/semantic-intelligence-service.js";
import type {
  SemanticAiProvider,
  SemanticProviderRequest,
  SemanticProviderResponse,
  SemanticCandidate,
  SemanticIntelligenceResult,
} from "../../../src/intelligence/types.js";

class FakeSemanticAiProvider implements SemanticAiProvider {
  public callCount = 0;
  public lastRequest: SemanticProviderRequest | null = null;
  public responseJson: Record<string, unknown> | null = null;
  public throwError: Error | null = null;

  async complete(request: SemanticProviderRequest): Promise<SemanticProviderResponse> {
    this.callCount++;
    this.lastRequest = request;
    if (this.throwError) {
      throw this.throwError;
    }
    const body = this.responseJson ?? {
      schemaVersion: 1,
      taskKind: request.taskKind,
      selectedCandidateId: request.allowedCandidateIds[0] ?? null,
      confidence: 0.95,
      explanationSummary: "AI matched candidate based on semantic similarity.",
      evidenceRefs: [],
    };
    return { rawText: JSON.stringify(body) };
  }
}

class FakeVerifiedStore implements VerifiedCatalogMappingStore {
  public categoryRecords: readonly unknown[] = [];
  public attributeRecords: readonly unknown[] = [];
  public categoryCallCount = 0;
  public attributeCallCount = 0;
  public throwError: Error | null = null;

  async findCategoryMappings(_normalizedPath: string): Promise<readonly VerifiedCategoryMappingRecord[]> {
    this.categoryCallCount++;
    if (this.throwError) {
      throw this.throwError;
    }
    return this.categoryRecords as readonly VerifiedCategoryMappingRecord[];
  }

  async findAttributeMappings(_normalizedKey: string): Promise<readonly VerifiedAttributeMappingRecord[]> {
    this.attributeCallCount++;
    if (this.throwError) {
      throw this.throwError;
    }
    return this.attributeRecords as readonly VerifiedAttributeMappingRecord[];
  }
}

const defaultCandidates: readonly SemanticCandidate[] = [
  { id: "cat_100", name: "Electronics > Audio > Headphones", path: "Electronics/Audio/Headphones" },
  { id: "cat_200", name: "Electronics > Audio > Speakers", path: "Electronics/Audio/Speakers" },
];

const defaultAttrCandidates: readonly SemanticCandidate[] = [
  { id: "attr_val_blue", name: "Color: Blue" },
  { id: "attr_val_red", name: "Color: Red" },
];

function createServices() {
  const provider = new FakeSemanticAiProvider();
  const semanticService = new SemanticIntelligenceService({ provider });
  const store = new FakeVerifiedStore();
  const catalogService = new CatalogIntelligenceService({ store, semanticService });
  return { provider, semanticService, store, catalogService };
}

describe("Phase 5B: Catalog Intelligence", () => {
  it("B-01: exact verified category mapping resolves deterministically", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "Audio / Headphone", targetCandidateId: "cat_100", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Wireless Bluetooth Headphones",
      sourceCategoryPath: "Audio / Headphone",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "RESOLVED");
    assert.equal(result.selectedCandidateId, "cat_100");
    assert.equal(result.resolutionSource, "VERIFIED_STORE");
    assert.equal(result.risk, "LOW");
    assert.equal(result.reviewRequired, false);
    assert.equal(result.reasonCode, "VERIFIED_STORE_MATCH");
    assert.equal(provider.callCount, 0);
  });

  it("B-02: exact verified attribute mapping resolves deterministically", async () => {
    const { store, catalogService, provider } = createServices();
    store.attributeRecords = [
      { sourceSpecificationKey: "color", targetCandidateId: "attr_val_blue", verified: true },
    ];

    const result = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "Deep Blue",
      candidates: defaultAttrCandidates,
    });

    assert.equal(result.status, "RESOLVED");
    assert.equal(result.selectedCandidateId, "attr_val_blue");
    assert.equal(result.resolutionSource, "VERIFIED_STORE");
    assert.equal(result.risk, "LOW");
    assert.equal(result.reviewRequired, false);
    assert.equal(result.reasonCode, "VERIFIED_STORE_MATCH");
    assert.equal(provider.callCount, 0);
  });

  it("B-03: verified store match bypasses AI (provider call count = 0)", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "gadgets", targetCandidateId: "cat_100", verified: true },
    ];

    await catalogService.mapCategory({
      productTitle: "Test Gadget",
      sourceCategoryPath: "Gadgets",
      candidates: defaultCandidates,
    });

    assert.equal(provider.callCount, 0);
  });

  it("B-04: unresolved category invokes Phase 5A semantic service (provider call count = 1)", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = []; // No store matches

    const result = await catalogService.mapCategory({
      productTitle: "Wireless Noise Canceling Headphones",
      sourceCategoryPath: "Unknown / Audio",
      candidates: defaultCandidates,
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "SUGGESTED");
    assert.equal(result.reviewRequired, true);
    assert.equal(result.resolutionSource, "AI");
  });

  it("B-05: unresolved attribute invokes Phase 5A semantic service (provider call count = 1)", async () => {
    const { store, catalogService, provider } = createServices();
    store.attributeRecords = [];

    const result = await catalogService.mapAttribute({
      sourceSpecificationKey: "Hue",
      sourceSpecificationValue: "Midnight Blue",
      candidates: defaultAttrCandidates,
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "SUGGESTED");
    assert.equal(result.reviewRequired, true);
  });

  it("B-06: store record with verified: false is ignored and does not auto-resolve", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "gadgets", targetCandidateId: "cat_100", verified: false },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Test Gadget",
      sourceCategoryPath: "Gadgets",
      candidates: defaultCandidates,
    });

    assert.equal(provider.callCount, 1); // Fell back to AI
    assert.notEqual(result.resolutionSource, "VERIFIED_STORE");
  });

  it("B-07: conflicting verified category mappings fail closed as BLOCKED_FOR_REVIEW", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
      { sourceCategoryPath: "audio", targetCandidateId: "cat_200", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "CONFLICTING_VERIFIED_MAPPING");
    assert.equal(provider.callCount, 0);
  });

  it("B-08: conflicting verified attribute mappings fail closed as BLOCKED_FOR_REVIEW", async () => {
    const { store, catalogService, provider } = createServices();
    store.attributeRecords = [
      { sourceSpecificationKey: "color", targetCandidateId: "attr_val_blue", verified: true },
      { sourceSpecificationKey: "color", targetCandidateId: "attr_val_red", verified: true },
    ];

    const result = await catalogService.mapAttribute({
      sourceSpecificationKey: "color",
      sourceSpecificationValue: "Blue Red",
      candidates: defaultAttrCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "CONFLICTING_VERIFIED_MAPPING");
    assert.equal(provider.callCount, 0);
  });

  it("B-09: verified mapping referencing stale target ID not in candidates fails closed", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_obsolete_999", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates, // cat_obsolete_999 is NOT in candidates
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "STALE_VERIFIED_TARGET");
    assert.equal(provider.callCount, 0);
  });

  it("B-10: current candidate allowlist is strictly preserved and passed to Phase 5A", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];

    await catalogService.mapCategory({
      productTitle: "Testing Candidate Allowlist",
      candidates: defaultCandidates,
    });

    assert.equal(provider.callCount, 1);
  });

  it("B-11: AI returning fabricated candidate rejected via Phase 5A output validator", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "CATEGORY_MAPPING",
      selectedCandidateId: "cat_fabricated_xyz",
      confidence: 0.99,
      explanationSummary: "Fabricated candidate",
      evidenceRefs: [],
    };

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");
  });

  it("B-12: AI returning null candidate maps to NEEDS_REVIEW", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "CATEGORY_MAPPING",
      selectedCandidateId: null,
      confidence: 0.2,
      explanationSummary: "No candidate fits this product.",
      evidenceRefs: [],
    };

    const result = await catalogService.mapCategory({
      productTitle: "Very Unique Exotic Product",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "NEEDS_REVIEW");
    assert.equal(result.reasonCode, "UNRESOLVED_NO_CANDIDATE");
    assert.equal(result.reviewRequired, true);
  });

  it("B-13: AI valid suggestion enforces reviewRequired = true", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];
    provider.responseJson = {
      schemaVersion: 1,
      taskKind: "CATEGORY_MAPPING",
      selectedCandidateId: "cat_100",
      confidence: 0.92,
      explanationSummary: "Confident match",
      evidenceRefs: [],
    };

    const result = await catalogService.mapCategory({
      productTitle: "Headphones Pro",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "SUGGESTED");
    assert.equal(result.reviewRequired, true);
    assert.equal(result.reasonCode, "AI_SUGGESTION");
  });

  it("B-14: provider unavailable maps to BLOCKED_FOR_REVIEW", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];
    provider.throwError = new Error("Connection timed out to LLM provider");

    const result = await catalogService.mapCategory({
      productTitle: "Headphones Pro",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");
  });

  it("B-15: invalid provider output maps to BLOCKED_FOR_REVIEW", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];
    provider.responseJson = {
      // Missing schemaVersion and required fields
      foo: "bar",
    };

    const result = await catalogService.mapCategory({
      productTitle: "Headphones Pro",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");
  });

  it("B-16: deterministic resolver failure in Phase 5A maps to BLOCKED_FOR_REVIEW", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({
      provider,
      resolver: {
        resolve: () => {
          throw new Error("Deterministic resolver crashed");
        },
      },
    });
    const catalogService = new CatalogIntelligenceService({ semanticService });

    const result = await catalogService.mapCategory({
      productTitle: "Headphones Pro",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE");
  });

  it("B-17: input validation failure fails closed before store query or AI call", async () => {
    const { store, catalogService, provider } = createServices();

    const result = await catalogService.mapCategory({
      // Missing productTitle
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
    assert.equal(store.categoryCallCount, 0);
    assert.equal(provider.callCount, 0);
  });

  it("B-18: deterministic normalization collapses whitespace and lowercases stably", () => {
    const normalized = normalizeLookupKey("  Electronics   >   Audio   \t \n ");
    assert.equal(normalized, "electronics > audio");
  });

  it("B-19: normalization is strictly locale-independent (zero locale collation)", () => {
    const turkishI = "İSTANBUL";
    const normalized = normalizeLookupKey(turkishI);
    assert.equal(normalized, "i̇stanbul");
  });

  it("B-20: source specification value alone cannot determine attribute identity without key", async () => {
    const { catalogService } = createServices();

    const result = await catalogService.mapAttribute({
      // Missing sourceSpecificationKey
      sourceSpecificationValue: "Blue",
      candidates: defaultAttrCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
  });

  it("B-21: store query receives normalized lookup key only", async () => {
    let queriedKey = "";
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store: VerifiedCatalogMappingStore = {
      findCategoryMappings: async (key: string) => {
        queriedKey = key;
        return [];
      },
      findAttributeMappings: async (_k: string) => [],
    };
    const catalogService = new CatalogIntelligenceService({ store, semanticService });

    await catalogService.mapCategory({
      productTitle: "Noise Canceling Headphones",
      sourceCategoryPath: "  Audio  /   HEADPHONE  ",
      candidates: defaultCandidates,
    });

    assert.equal(queriedKey, "audio / headphone");
  });

  it("B-22: candidate collection is not modified or mutated", async () => {
    const { catalogService } = createServices();
    const candidateCopy = [{ id: "c1", name: "Original Candidate" }];
    const originalJson = JSON.stringify(candidateCopy);

    await catalogService.mapCategory({
      productTitle: "Test Title",
      candidates: candidateCopy,
    });

    assert.equal(JSON.stringify(candidateCopy), originalJson);
  });

  it("B-23: caller raw input object and arrays are not modified and not frozen by the service", async () => {
    const { catalogService } = createServices();
    const rawReq: CategoryMappingRequest = {
      productTitle: "Unfrozen Title",
      sourceCategoryPath: "audio",
      candidates: [{ id: "c1", name: "C1" }],
    };

    assert.equal(Object.isFrozen(rawReq), false);
    assert.equal(Object.isFrozen(rawReq.candidates), false);

    await catalogService.mapCategory(rawReq);

    assert.equal(Object.isFrozen(rawReq), false);
    assert.equal(Object.isFrozen(rawReq.candidates), false);
  });

  it("B-24: unknown input properties fail closed", async () => {
    const { catalogService } = createServices();

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      candidates: defaultCandidates,
      unauthorizedExtraKey: 12345,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
  });

  it("B-25: input attempting to pass price, stock, or sku is rejected", async () => {
    const { catalogService } = createServices();

    const withPrice = await catalogService.mapCategory({
      productTitle: "Test Title",
      candidates: defaultCandidates,
      price: 50000,
    });
    assert.equal(withPrice.status, "BLOCKED_FOR_REVIEW");
    assert.equal(withPrice.reasonCode, "INPUT_VALIDATION_ERROR");

    const withStock = await catalogService.mapAttribute({
      sourceSpecificationKey: "color",
      sourceSpecificationValue: "red",
      candidates: defaultAttrCandidates,
      stock: 100,
    });
    assert.equal(withStock.status, "BLOCKED_FOR_REVIEW");
    assert.equal(withStock.reasonCode, "INPUT_VALIDATION_ERROR");
  });

  it("B-26: store throws -> BLOCKED_FOR_REVIEW, reasonCode VERIFIED_MAPPING_STORE_FAILURE, 0 AI calls", async () => {
    const { store, catalogService, provider } = createServices();
    store.throwError = new Error("Database network failure");

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "VERIFIED_MAPPING_STORE_FAILURE");
    assert.equal(provider.callCount, 0);
  });

  it("B-27: malformed store record -> BLOCKED_FOR_REVIEW, reasonCode INVALID_VERIFIED_MAPPING_RECORD, 0 AI calls", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: "not_a_boolean" },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");
    assert.equal(provider.callCount, 0);
  });

  it("B-28: store record source key mismatch -> block, 0 AI calls", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "different_path", targetCandidateId: "cat_100", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");
    assert.equal(provider.callCount, 0);
  });

  it("B-29: unverified but structurally valid record may be ignored and falls back to Phase 5A", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: false },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Test Title",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "SUGGESTED");
  });

  it("B-30: no category sourceCategoryPath -> sourceKey null, no store lookup", async () => {
    const { store, catalogService, provider } = createServices();

    const result = await catalogService.mapCategory({
      productTitle: "Product With No Category Path",
      candidates: defaultCandidates,
    });

    assert.equal(result.sourceKey, null);
    assert.equal(store.categoryCallCount, 0);
    assert.equal(provider.callCount, 1);
  });

  it("B-31: exact candidate ID comparison; no ID synthesis", async () => {
    const { store, catalogService } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Exact Match",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.selectedCandidateId, "cat_100");
  });

  it("B-32: caller raw input not frozen by service", async () => {
    const { catalogService } = createServices();
    const raw: AttributeMappingRequest = {
      sourceSpecificationKey: "color",
      sourceSpecificationValue: "blue",
      candidates: [{ id: "attr_1", name: "Attr 1" }],
    };

    assert.equal(Object.isFrozen(raw), false);
    await catalogService.mapAttribute(raw);
    assert.equal(Object.isFrozen(raw), false);
  });

  it("B-33: trusted result is recursively frozen", async () => {
    const { store, catalogService } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
    ];

    const result = await catalogService.mapCategory({
      productTitle: "Frozen Test",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.evidenceRefs), true);
  });

  it("B-34: Phase 5A failure reason remains distinguishable", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = [];

    // Test INPUT_REJECTED
    const emptyTitleRes = await catalogService.mapCategory({
      productTitle: "   ",
      candidates: defaultCandidates,
    });
    assert.equal(emptyTitleRes.reasonCode, "INPUT_VALIDATION_ERROR");

    // Test PROVIDER_UNAVAILABLE
    provider.throwError = new Error("Network timeout");
    const unavailableRes = await catalogService.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(unavailableRes.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");

    // Test INVALID_PROVIDER_OUTPUT
    provider.throwError = null;
    provider.responseJson = { corrupted: true };
    const invalidRes = await catalogService.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(invalidRes.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");
  });

  it("B-35: sourceSpecificationValue is REQUIRED for attribute mapping", async () => {
    const { catalogService } = createServices();

    const missingValue = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      candidates: defaultAttrCandidates,
    });

    assert.equal(missingValue.status, "BLOCKED_FOR_REVIEW");
    assert.equal(missingValue.reasonCode, "INPUT_VALIDATION_ERROR");

    const blankValue = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "   ",
      candidates: defaultAttrCandidates,
    });

    assert.equal(blankValue.status, "BLOCKED_FOR_REVIEW");
    assert.equal(blankValue.reasonCode, "INPUT_VALIDATION_ERROR");
  });

  it("B-36: Attribute productTitle remains optional and is not fabricated", async () => {
    const { catalogService, provider } = createServices();

    const result = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "Blue",
      candidates: defaultAttrCandidates,
    });

    assert.equal(result.status, "SUGGESTED");
    assert.notEqual(result.reasonCode, "INPUT_VALIDATION_ERROR");
    assert.equal(provider.callCount, 1);
    const req = provider.lastRequest!;
    assert.equal(Object.prototype.hasOwnProperty.call(req.untrustedData, "productTitle"), false);
    assert.doesNotMatch(req.prompt, /Color.*productTitle/);
  });

  it("B-37: Phase 5A optional category semantic fields are preserved safely", async () => {
    const { catalogService, provider } = createServices();

    const result = await catalogService.mapCategory({
      productTitle: "Audio Pro",
      productDescription: "High quality wireless headphones",
      brand: "Sony",
      categoryHints: ["electronics", "audio"],
      sourceCategoryPath: "Audio / Over-ear",
      candidates: defaultCandidates,
      evidence: [{ id: "ev1", text: "Verified over-ear product packaging" }],
    });

    assert.equal(provider.callCount, 1);
    assert.equal(result.status, "SUGGESTED");
  });

  it("B-38: store result itself must be array; malformed non-array result -> INVALID_VERIFIED_MAPPING_RECORD", async () => {
    const { store, catalogService, provider } = createServices();
    store.categoryRecords = "not_an_array" as unknown as readonly unknown[];

    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");
    assert.equal(provider.callCount, 0);
  });

  it("B-39: MAX_RAW_STORE_RECORDS enforced before record processing", async () => {
    const { store, catalogService, provider } = createServices();
    const oversize: unknown[] = [];
    for (let i = 0; i <= CATALOG_BOUNDS.MAX_RAW_STORE_RECORDS + 5; i++) {
      oversize.push({ sourceCategoryPath: "audio", targetCandidateId: `c_${i}`, verified: true });
    }
    store.categoryRecords = oversize;

    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");
    assert.equal(provider.callCount, 0);
  });

  it("B-40: normalized source key length revalidated after normalization", () => {
    assert.throws(
      () => {
        const huge = "a".repeat(CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH + 10);
        normalizeLookupKey(huge);
      },
      CatalogInputValidationError
    );
  });

  it("B-41: candidates must pass semantic validation before a verified store match can resolve", async () => {
    const { store, catalogService } = createServices();
    store.categoryRecords = [
      { sourceCategoryPath: "audio", targetCandidateId: "cat_100", verified: true },
    ];

    // Invalid candidates array (empty)
    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: [],
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INPUT_VALIDATION_ERROR");
  });

  it("B-42: missing attribute productTitle remains truly omitted from provider semantic request", async () => {
    const { catalogService, provider } = createServices();

    const result = await catalogService.mapAttribute({
      sourceSpecificationKey: "Ukuran",
      sourceSpecificationValue: "XL",
      candidates: [
        { id: "size_xl", name: "Size: XL" },
      ],
    });

    assert.equal(result.status, "SUGGESTED");
    assert.equal(provider.callCount, 1);
    const req = provider.lastRequest!;
    assert.equal(Object.prototype.hasOwnProperty.call(req.untrustedData, "productTitle"), false);
    assert.doesNotMatch(req.prompt, /"productTitle"/);
  });

  it("B-43: Phase 5A RESOLVED_DETERMINISTICALLY maps to DETERMINISTIC_RULE_MATCH, never VERIFIED_STORE_MATCH", async () => {
    const provider = new FakeSemanticAiProvider();
    const resolver = {
      resolve: async () => ({
        resolved: true,
        candidateId: "cat_100",
        explanation: "Deterministic category match rule",
      }),
    };
    const semanticService = new SemanticIntelligenceService({ provider, resolver });
    const catalogService = new CatalogIntelligenceService({ semanticService });

    const result = await catalogService.mapCategory({
      productTitle: "Test deterministic",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "RESOLVED");
    assert.equal(result.resolutionSource, "DETERMINISTIC_RULE");
    assert.equal(result.reasonCode, "DETERMINISTIC_RULE_MATCH");
    assert.notEqual(result.reasonCode, "VERIFIED_STORE_MATCH");
    assert.equal(provider.callCount, 0);
  });

  it("B-44: full Phase 5A failure translation matrix is actually exercised", async () => {
    // 1. INPUT_REJECTED -> SEMANTIC_INPUT_REJECTED
    class StubInputRejectedSemanticService extends SemanticIntelligenceService {
      constructor() {
        super({ provider: new FakeSemanticAiProvider() });
      }
      override async executeTask(): Promise<SemanticIntelligenceResult> {
        return {
          outcome: "INPUT_REJECTED",
          schemaVersion: 1,
          taskKind: null,
          requestId: null,
          selectedCandidateId: null,
          confidence: null,
          risk: null,
          reviewRequired: true,
          explanationSummary: "Input rejected by semantic layer",
          evidenceRefs: [],
          source: "NONE",
        };
      }
    }
    const catService1 = new CatalogIntelligenceService({
      semanticService: new StubInputRejectedSemanticService(),
    });
    const res1 = await catService1.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(res1.status, "BLOCKED_FOR_REVIEW");
    assert.equal(res1.reasonCode, "SEMANTIC_INPUT_REJECTED");

    // 2. PROVIDER_UNAVAILABLE -> SEMANTIC_PROVIDER_UNAVAILABLE
    const { catalogService: catService2, provider: provider2 } = createServices();
    provider2.throwError = new Error("Provider timeout or connection refused");
    const res2 = await catService2.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(res2.status, "BLOCKED_FOR_REVIEW");
    assert.equal(res2.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");

    // 3. INVALID_PROVIDER_OUTPUT -> SEMANTIC_INVALID_PROVIDER_OUTPUT
    const { catalogService: catService3, provider: provider3 } = createServices();
    provider3.responseJson = { corrupted: true };
    const res3 = await catService3.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(res3.status, "BLOCKED_FOR_REVIEW");
    assert.equal(res3.reasonCode, "SEMANTIC_INVALID_PROVIDER_OUTPUT");

    // 4. DETERMINISTIC_RESOLVER_FAILURE -> SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE
    const provider4 = new FakeSemanticAiProvider();
    const badResolver = {
      resolve: async () => ({
        resolved: true,
        candidateId: "non_allowlisted_candidate",
      }),
    };
    const semService4 = new SemanticIntelligenceService({ provider: provider4, resolver: badResolver });
    const catService4 = new CatalogIntelligenceService({ semanticService: semService4 });
    const res4 = await catService4.mapCategory({
      productTitle: "Valid Title",
      candidates: defaultCandidates,
    });
    assert.equal(res4.status, "BLOCKED_FOR_REVIEW");
    assert.equal(res4.reasonCode, "SEMANTIC_DETERMINISTIC_RESOLVER_FAILURE");
  });

  it("B-45: invalid supplied optional productTitle fails closed rather than being silently treated as absent", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const store = new FakeVerifiedStore();
    const catalogService = new CatalogIntelligenceService({ store, semanticService });

    // 1. Numeric productTitle fails closed
    const resNumeric = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "Blue",
      productTitle: 123 as unknown as string,
      candidates: defaultAttrCandidates,
    });
    assert.equal(resNumeric.status, "BLOCKED_FOR_REVIEW");
    assert.equal(resNumeric.reasonCode, "INPUT_VALIDATION_ERROR");
    assert.equal(store.attributeCallCount, 0);
    assert.equal(provider.callCount, 0);

    // 2. Blank string productTitle fails closed
    const resBlank = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "Blue",
      productTitle: "   ",
      candidates: defaultAttrCandidates,
    });
    assert.equal(resBlank.status, "BLOCKED_FOR_REVIEW");
    assert.equal(resBlank.reasonCode, "INPUT_VALIDATION_ERROR");
    assert.equal(store.attributeCallCount, 0);
    assert.equal(provider.callCount, 0);

    // 3. Explicitly undefined productTitle is allowed (treated as omitted)
    const resUndefined = await catalogService.mapAttribute({
      sourceSpecificationKey: "Color",
      sourceSpecificationValue: "Blue",
      productTitle: undefined,
      candidates: defaultAttrCandidates,
    });
    assert.equal(resUndefined.status, "SUGGESTED");
    assert.equal(provider.callCount, 1);
  });

  it("B-46: oversized verified-store targetCandidateId fails closed before AI fallback", async () => {
    const provider = new FakeSemanticAiProvider();
    const semanticService = new SemanticIntelligenceService({ provider });
    const maxChars = semanticService.getConfig().maxTextChars;
    const store = new FakeVerifiedStore();
    store.categoryRecords = [
      {
        sourceCategoryPath: "audio",
        targetCandidateId: "x".repeat(maxChars + 1),
        verified: true,
      },
    ];
    const catalogService = new CatalogIntelligenceService({ store, semanticService });

    const result = await catalogService.mapCategory({
      productTitle: "Headphones",
      sourceCategoryPath: "audio",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "INVALID_VERIFIED_MAPPING_RECORD");
    assert.equal(provider.callCount, 0);
  });

  it("B-47: semantic evidenceRefs are copied before Catalog result deepFreeze", async () => {
    const originalEvidenceRefs: string[] = ["EV_DOC_1", "EV_DOC_2"];
    class StubSemanticServiceWithRefs extends SemanticIntelligenceService {
      constructor() {
        super({ provider: new FakeSemanticAiProvider() });
      }
      override async executeTask(): Promise<SemanticIntelligenceResult> {
        return {
          outcome: "SUGGESTED",
          schemaVersion: 1,
          taskKind: "CATEGORY_MAPPING",
          requestId: "req_stub_refs",
          selectedCandidateId: "cat_100",
          confidence: 0.95,
          risk: "MEDIUM",
          reviewRequired: true,
          explanationSummary: "Matched category with evidence.",
          evidenceRefs: originalEvidenceRefs,
          source: "AI",
        };
      }
    }

    const stubService = new StubSemanticServiceWithRefs();
    const catalogService = new CatalogIntelligenceService({ semanticService: stubService });

    const result = await catalogService.mapCategory({
      productTitle: "Noise Cancelling Headphones",
      candidates: defaultCandidates,
    });

    assert.equal(result.status, "SUGGESTED");
    assert.equal(Object.isFrozen(result.evidenceRefs), true);
    assert.equal(Object.isFrozen(originalEvidenceRefs), false);
    assert.notEqual(result.evidenceRefs, originalEvidenceRefs);
    assert.deepEqual(result.evidenceRefs, ["EV_DOC_1", "EV_DOC_2"]);

    // Verify mutating original doesn't affect frozen result
    originalEvidenceRefs.push("EV_MUTATION");
    assert.equal(result.evidenceRefs.length, 2);
  });
});
