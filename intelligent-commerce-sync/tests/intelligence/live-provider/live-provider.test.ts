/**
 * Phase 5E: Live Semantic AI Provider Test Suite
 * Zero live network, fully isolated, comprehensive safety & protocol verification.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LiveAiProvider,
  createLiveAiProviderFromEnv,
  OPENAI_RESPONSES_ENDPOINT,
} from "../../../src/intelligence/live-provider/live-ai-provider.js";
import {
  resolveLiveProviderConfig,
  resolveLiveProviderConfigFromEnv,
} from "../../../src/intelligence/live-provider/config.js";
import {
  SemanticConfigurationError,
  SemanticProviderError,
  type SemanticProviderRequest,
} from "../../../src/intelligence/types.js";
import type {
  Clock,
  LiveProviderConfig,
  LiveProviderFetch,
} from "../../../src/intelligence/live-provider/types.js";
import { SemanticIntelligenceService } from "../../../src/intelligence/semantic-intelligence-service.js";
import { CatalogIntelligenceService } from "../../../src/intelligence/catalog/catalog-intelligence-service.js";
import { ReviewIntelligenceService } from "../../../src/intelligence/review/review-intelligence-service.js";
import { ParserRecoveryService } from "../../../src/intelligence/parser-recovery/parser-recovery-service.js";

class FakeClock implements Clock {
  private currentMs = 1_000_000;
  nowMs(): number {
    return this.currentMs;
  }
  advanceMs(ms: number): void {
    this.currentMs += ms;
  }
}

function createSampleRequest(overrides?: Partial<SemanticProviderRequest>): SemanticProviderRequest {
  const controller = new AbortController();
  return {
    requestId: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    taskKind: "CATEGORY_MAPPING",
    prompt: "Test prompt content",
    systemInstruction: "Test system instruction content",
    untrustedData: {
      taskKind: "CATEGORY_MAPPING",
      productTitle: "Test Product Title",
      candidates: [
        { id: "c-1", name: "Category One" },
        { id: "c-2", name: "Category Two" },
      ],
      evidence: [
        { id: "e-1", text: "Evidence One" },
      ],
    },
    allowedCandidateIds: ["c-1", "c-2"],
    allowedEvidenceIds: ["e-1"],
    signal: controller.signal,
    ...overrides,
  };
}

function createMockResponseJson(
  rawText: string,
  options?: {
    usage?: { input_tokens: number; output_tokens: number; total_tokens: number };
    status?: string;
    incompleteReason?: string;
    output?: unknown[];
    error?: unknown;
    object?: string;
  }
): string {
  const defaultOutput = [
    {
      type: "reasoning",
      summary: "Non-text reasoning steps",
    },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: rawText,
        },
      ],
    },
  ];

  const obj = {
    object: options?.object ?? "response",
    status: options?.status ?? "completed",
    error: options?.error ?? null,
    output: options?.output ?? defaultOutput,
    ...(options?.incompleteReason ? { incomplete_details: { reason: options.incompleteReason } } : {}),
    ...(options?.usage ? { usage: options.usage } : {}),
  };

  return JSON.stringify(obj);
}

function createFakeTransport(handler: (url: string, init: RequestInit) => Promise<Response>): LiveProviderFetch {
  return (url: string, init: RequestInit) => handler(url, init);
}

function createCustomResponse(obj: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: async () => obj,
    text: async () => (typeof obj === "string" ? obj : JSON.stringify(obj)),
  } as unknown as Response;
}

describe("Phase 5E: Configuration & Secret Isolation Boundary", () => {
  it("defaults to DISABLED mode and gpt-5.6-luna", () => {
    const config = resolveLiveProviderConfig();
    assert.equal(config.mode, "DISABLED");
    assert.equal(config.provider, "OPENAI");
    assert.equal(config.model, "gpt-5.6-luna");
    assert.equal(config.maxOutputTokens, 800);
    assert.equal(config.maxRequestTextChars, 16000);
    assert.equal(config.maxRequestsPerWindow, 60);
    assert.equal(config.windowMs, 60000);
    assert.equal(config.maxRequestsPerProcess, 1000);
    assert.equal(config.failureThreshold, 5);
    assert.equal(config.cooldownMs, 30000);
  });

  it("public resolveLiveProviderConfigFromEnv never returns apiKey", () => {
    const config = resolveLiveProviderConfigFromEnv({
      AI_PROVIDER_MODE: "LIVE",
      OPENAI_API_KEY: "super-secret-key-999",
    });

    assert.equal("apiKey" in config, false);
    assert.equal((config as any).apiKey, undefined);

    const provider = new LiveAiProvider(config, "super-secret-key-999");
    const publicConfig = provider.getConfig();
    assert.equal("apiKey" in publicConfig, false);

    const snapshot = provider.getUsageSnapshot();
    assert.equal("apiKey" in snapshot, false);
  });

  it("createLiveAiProviderFromEnv isolates apiKey privately and minimizes secrets in non-LIVE modes", async () => {
    let transportCalled = false;
    const transport = createFakeTransport(async () => {
      transportCalled = true;
      return new Response("{}", { status: 200 });
    });

    const provider = createLiveAiProviderFromEnv({
      AI_PROVIDER_MODE: "DRY_RUN",
      OPENAI_API_KEY: "SHOULD_NOT_BE_USED",
    }, { transport });

    assert.equal(provider.getConfig().mode, "DRY_RUN");
    assert.equal("apiKey" in provider.getConfig(), false);
    assert.equal("apiKey" in provider.getUsageSnapshot(), false);

    // Rejects safely in DRY_RUN with zero network dispatches
    await assert.rejects(
      () => provider.complete(createSampleRequest()),
      /DRY_RUN mode; network dispatch simulated safely/
    );
    assert.equal(transportCalled, false);
    assert.equal(provider.getUsageSnapshot().networkDispatches, 0);

    // LIVE mode still strictly requires non-blank key
    assert.throws(
      () => createLiveAiProviderFromEnv({ AI_PROVIDER_MODE: "LIVE", OPENAI_API_KEY: "" }),
      /OPENAI_API_KEY is required and must not be blank in LIVE mode/
    );
    assert.throws(
      () => createLiveAiProviderFromEnv({ AI_PROVIDER_MODE: "LIVE" }),
      /OPENAI_API_KEY is required and must not be blank in LIVE mode/
    );
  });

  it("rejects non-plain objects, symbols, or unknown properties in config", () => {
    assert.throws(
      () => resolveLiveProviderConfig([] as any),
      /plain object/
    );
    assert.throws(
      () => resolveLiveProviderConfig(null as any),
      /plain object/
    );
    assert.throws(
      () => resolveLiveProviderConfig("config" as any),
      /plain object/
    );

    const symbolConfig = { [Symbol("bad")]: true };
    assert.throws(
      () => resolveLiveProviderConfig(symbolConfig as any),
      /symbol-keyed/
    );

    assert.throws(
      () => resolveLiveProviderConfig({ unknownOption: "bad" } as any),
      /Unknown property 'unknownOption'/
    );
  });

  it("rejects invalid mode, provider, or model", () => {
    assert.throws(
      () => resolveLiveProviderConfig({ mode: "INVALID_MODE" as any }),
      /Allowed modes: DISABLED, DRY_RUN, LIVE/
    );
    assert.throws(
      () => resolveLiveProviderConfig({ provider: "ANTHROPIC" as any }),
      /Exactly 'OPENAI' is supported/
    );
    assert.throws(
      () => resolveLiveProviderConfig({ model: "gpt-4o" as any }),
      /Exactly 'gpt-5\.6-luna' is supported/
    );
  });

  it("rejects non-integer, negative, or infinite numeric bounds", () => {
    assert.throws(
      () => resolveLiveProviderConfig({ maxRequestsPerProcess: 0 }),
      /maxRequestsPerProcess/
    );
    assert.throws(
      () => resolveLiveProviderConfig({ maxOutputTokens: -10 }),
      /maxOutputTokens/
    );
    assert.throws(
      () => resolveLiveProviderConfig({ windowMs: Infinity }),
      /windowMs/
    );
    assert.throws(
      () => resolveLiveProviderConfig({ failureThreshold: 3.5 }),
      /failureThreshold/
    );
  });

  it("freezes resolved config snapshot and leaves caller config unfrozen", () => {
    const callerConfig = { maxOutputTokens: 500 };
    const resolved = resolveLiveProviderConfig(callerConfig);

    assert.equal(Object.isFrozen(resolved), true);
    assert.equal(Object.isFrozen(callerConfig), false);

    // Mutation of resolved throws
    assert.throws(() => {
      (resolved as any).maxOutputTokens = 999;
    });

    // Caller config is still mutable
    callerConfig.maxOutputTokens = 600;
    assert.equal(callerConfig.maxOutputTokens, 600);
  });

  it("direct LiveAiProvider constructor validates config snapshot and credentials", () => {
    // Cannot bypass invalid model
    assert.throws(
      () => new LiveAiProvider({ model: "invalid" } as any, "key"),
      /Exactly 'gpt-5\.6-luna' is supported/
    );

    // Cannot bypass numeric bounds
    assert.throws(
      () => new LiveAiProvider({ maxOutputTokens: 100.5 } as any, "key"),
      /finite integer/
    );
    assert.throws(
      () => new LiveAiProvider({ maxOutputTokens: -1 } as any, "key"),
      /between 50 and 4000/
    );

    // LIVE mode requires non-blank key at construction time
    const liveConfig = resolveLiveProviderConfig({ mode: "LIVE" });
    assert.throws(
      () => new LiveAiProvider(liveConfig, null),
      /OPENAI_API_KEY is required and must not be blank in LIVE mode/
    );
    assert.throws(
      () => new LiveAiProvider(liveConfig, ""),
      /OPENAI_API_KEY is required and must not be blank in LIVE mode/
    );
    assert.throws(
      () => new LiveAiProvider(liveConfig, "   "),
      /OPENAI_API_KEY is required and must not be blank in LIVE mode/
    );

    // DISABLED and DRY_RUN allow null key
    const disabledConfig = resolveLiveProviderConfig({ mode: "DISABLED" });
    assert.doesNotThrow(() => new LiveAiProvider(disabledConfig, null));

    const dryRunConfig = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    assert.doesNotThrow(() => new LiveAiProvider(dryRunConfig, null));
  });

  it("rejects inherited config values from overriding defaults and rejects unknown own keys", () => {
    const customProto = {
      mode: "LIVE" as const,
      provider: "OPENAI" as const,
      model: "gpt-5.6-luna" as const,
      maxOutputTokens: 999,
      maxRequestTextChars: 12345,
      maxRequestsPerWindow: 2,
      windowMs: 2000,
      maxRequestsPerProcess: 5,
      failureThreshold: 2,
      cooldownMs: 5000,
    };
    const raw = Object.create(customProto);
    const resolved = resolveLiveProviderConfig(raw);
    assert.equal(resolved.mode, "DISABLED");
    assert.equal(resolved.maxOutputTokens, 800);
    assert.equal(resolved.maxRequestTextChars, 16000);
    assert.equal(resolved.maxRequestsPerWindow, 60);
    assert.equal(resolved.windowMs, 60000);
    assert.equal(resolved.maxRequestsPerProcess, 1000);
    assert.equal(resolved.failureThreshold, 5);
    assert.equal(resolved.cooldownMs, 30000);

    assert.throws(
      () => resolveLiveProviderConfig(Object.assign(Object.create(customProto), { unknownOwn: 123 })),
      /Unknown property 'unknownOwn'/
    );
  });
});

describe("Phase 5E: DISABLED Mode True No-Op & DRY_RUN Routing", () => {
  it("DISABLED mode short-circuits as a true no-op without mutating controls or validating request", async () => {
    const config = resolveLiveProviderConfig({ mode: "DISABLED" });
    let transportCalled = false;
    const transport = createFakeTransport(async () => {
      transportCalled = true;
      return new Response("{}", { status: 200 });
    });

    const provider = new LiveAiProvider(config, null, { transport });

    // Pass completely malformed / oversized / forbidden request
    const malformedRequest = {
      requestId: "invalid",
      taskKind: "NON_EXISTENT",
      prompt: "X".repeat(100_000), // Exceeds budget
      systemInstruction: "Y".repeat(100_000),
      untrustedData: { password: "secret_value" }, // Forbidden property name
      allowedCandidateIds: "not-an-array",
      allowedEvidenceIds: null,
      signal: {} as any, // Fake signal
    };

    await assert.rejects(
      async () => provider.complete(malformedRequest as any),
      (err: unknown) => {
        assert(err instanceof SemanticProviderError);
        assert.equal(err.message, "Semantic AI provider is DISABLED.");
        return true;
      }
    );

    assert.equal(transportCalled, false);
    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.completeCalls, 1);
    assert.equal(snapshot.dryRunChecks, 0);
    assert.equal(snapshot.networkDispatches, 0);
    assert.equal(snapshot.budgetBlocked, 0);
    assert.equal(snapshot.rateLimitBlocked, 0);
    assert.equal(snapshot.circuitBlocked, 0);
  });

  it("DRY_RUN mode performs full request and privacy validation before safe rejection", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // 1. Invalid envelope in DRY_RUN throws validation error
    await assert.rejects(
      async () => provider.complete(null as any),
      /plain object/
    );

    // 2. Forbidden property name in DRY_RUN throws privacy error
    const forbiddenReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Item",
        password: "secret",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(forbiddenReq),
      /Forbidden structural property name 'password'/
    );

    // 3. Valid request in DRY_RUN reaches safe dry-run exit
    const validReq = createSampleRequest();
    await assert.rejects(
      async () => provider.complete(validReq),
      (err: unknown) => {
        assert(err instanceof SemanticProviderError);
        assert.match(err.message, /DRY_RUN mode; network dispatch simulated safely/);
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.dryRunChecks, 1);
    assert.equal(snapshot.networkDispatches, 0);
    assert.equal(snapshot.rateLimitBlocked, 0);
    assert.equal(snapshot.circuitBlocked, 0);
    assert.equal(snapshot.budgetBlocked, 0);
  });
});

describe("Phase 5E: AbortSignal & Request Envelope Validation", () => {
  it("rejects fake or duck-typed AbortSignal objects", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // null signal
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: null as any })),
      /genuine AbortSignal/
    );

    // empty object
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: {} as any })),
      /genuine AbortSignal/
    );

    // duck-typed object { aborted: false }
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: { aborted: false } as any })),
      /genuine AbortSignal/
    );

    // class instance imitating only aborted
    class FakeSignal {
      aborted = false;
    }
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: new FakeSignal() as any })),
      /genuine AbortSignal/
    );

    // Object.create(AbortSignal.prototype)
    const protoFake = Object.create(AbortSignal.prototype);
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: protoFake as any })),
      /genuine AbortSignal/
    );

    // Valid AbortSignal accepts
    const validSignal = new AbortController().signal;
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ signal: validSignal })),
      /DRY_RUN mode/
    );
  });

  it("validates request envelope strictness (symbol keys, unknown fields, blank fields)", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Symbol keys
    const symbolReq = {
      ...createSampleRequest(),
      [Symbol("extra")]: true,
    };
    await assert.rejects(
      async () => provider.complete(symbolReq as any),
      /symbol-keyed/
    );

    // Unknown field
    const unknownFieldReq = {
      ...createSampleRequest(),
      extraField: "unexpected",
    };
    await assert.rejects(
      async () => provider.complete(unknownFieldReq as any),
      /must have exactly 8 properties/
    );

    // Blank prompt
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ prompt: "   " })),
      /prompt.*non-blank string/
    );

    // Blank system instruction
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ systemInstruction: "" })),
      /systemInstruction.*non-blank string/
    );

    // Invalid taskKind
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ taskKind: "INVALID_TASK" as any })),
      /taskKind.*invalid/
    );

    // Sparse allowedCandidateIds
    const sparseCandidates: string[] = ["c-1"];
    sparseCandidates[2] = "c-2"; // Hole at index 1
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedCandidateIds: sparseCandidates })),
      /dense array/
    );

    // Duplicate allowedCandidateIds
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedCandidateIds: ["c-1", "c-1"] })),
      /duplicates/
    );

    // Blank allowedCandidateId
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedCandidateIds: ["c-1", "  "] })),
      /dense array of non-blank strings/
    );

    // Duplicate allowedEvidenceIds
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedEvidenceIds: ["e-1", "e-1"] })),
      /duplicates/
    );
  });

  it("rejects invalid requestId format", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // 63 chars (too short)
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ requestId: "a".repeat(63) })),
      /requestId.*must be exactly 64 lowercase hexadecimal characters/
    );

    // 65 chars (too long)
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ requestId: "a".repeat(65) })),
      /requestId.*must be exactly 64 lowercase hexadecimal characters/
    );

    // Uppercase hex
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ requestId: "A".repeat(64) })),
      /requestId.*must be exactly 64 lowercase hexadecimal characters/
    );

    // Non-hex chars
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ requestId: "z".repeat(64) })),
      /requestId.*must be exactly 64 lowercase hexadecimal characters/
    );

    // Non-string
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ requestId: 12345 as any })),
      /requestId.*must be exactly 64 lowercase hexadecimal characters/
    );
  });

  it("rejects sparse allowedEvidenceIds and blank evidence IDs", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Sparse allowedEvidenceIds
    const sparseEvidence: string[] = ["e-1"];
    sparseEvidence[2] = "e-2";
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedEvidenceIds: sparseEvidence })),
      /dense array/
    );

    // Blank allowedEvidenceId
    await assert.rejects(
      async () => provider.complete(createSampleRequest({ allowedEvidenceIds: ["e-1", "   "] })),
      /dense array of non-blank strings/
    );
  });

  it("rejects request envelope with inherited required properties or prototype pollution", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);
    const sample = createSampleRequest();

    // 1. Inherited signal
    const { signal, ...sampleWithoutSignal } = sample;
    const protoWithSignal = { signal };
    const reqInheritedSignal = Object.assign(Object.create(protoWithSignal), sampleWithoutSignal);
    await assert.rejects(
      async () => provider.complete(reqInheritedSignal),
      /missing required property: 'signal'|must have exactly 8 properties/
    );

    // 2. Inherited taskKind
    const { taskKind, ...sampleWithoutTaskKind } = sample;
    const protoWithTaskKind = { taskKind };
    const reqInheritedTaskKind = Object.assign(Object.create(protoWithTaskKind), sampleWithoutTaskKind);
    await assert.rejects(
      async () => provider.complete(reqInheritedTaskKind),
      /missing required property: 'taskKind'|must have exactly 8 properties/
    );

    // 3. Temporary Object.prototype pollution
    try {
      (Object.prototype as any).signal = new AbortController().signal;
      const reqPolluted = { ...sampleWithoutSignal };
      await assert.rejects(
        async () => provider.complete(reqPolluted as any),
        /missing required property: 'signal'|must have exactly 8 properties/
      );
    } finally {
      delete (Object.prototype as any).signal;
    }
  });

  it("prevents unknown-own-key substitution from bypassing exact key gate", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);
    const sample = createSampleRequest();

    // 8 own keys: signal is omitted, unknown property 'substituteKey' is added
    const { signal, ...rest } = sample;
    const reqSubstituted = { ...rest, substituteKey: "illegal" };
    assert.equal(Object.keys(reqSubstituted).length, 8);

    await assert.rejects(
      async () => provider.complete(reqSubstituted as any),
      /contains unknown property: 'substituteKey'|missing required property: 'signal'/
    );
  });
});

describe("Phase 5E: Canonical Privacy Gate & Structural Validation", () => {
  it("validates all four authentic canonical Phase 5A shapes", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // 1. CATEGORY_MAPPING (with optional fields)
    const catReq = createSampleRequest({
      taskKind: "CATEGORY_MAPPING",
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Wireless Bluetooth Earbuds",
        productDescription: "High fidelity audio",
        brand: "AudioPro",
        categoryHints: ["Electronics", "Audio"],
        sourceCategoryPath: "Gadgets / Sound",
        candidates: [{ id: "c-1", name: "Headphones" }],
        evidence: [{ id: "e-1", text: "Bluetooth earbuds in title" }],
      },
      allowedCandidateIds: ["c-1"],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(() => provider.complete(catReq), /DRY_RUN mode/);

    // 2. ATTRIBUTE_MAPPING (with optional fields)
    const attrReq = createSampleRequest({
      taskKind: "ATTRIBUTE_MAPPING",
      untrustedData: {
        taskKind: "ATTRIBUTE_MAPPING",
        sourceSpecificationKey: "Warna",
        sourceSpecificationValue: "Merah",
        brand: "FashionBrand",
        productTitle: "Cotton T-Shirt",
        candidates: [{ id: "c-1", name: "Red" }],
        evidence: [{ id: "e-1", text: "Merah means red" }],
      },
      allowedCandidateIds: ["c-1"],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(() => provider.complete(attrReq), /DRY_RUN mode/);

    // 3. ANOMALY_REVIEW (with optional fields)
    const anomalyReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Luxury Smartphone",
        selectedCategoryPath: "Electronics / Phones",
        sourceSpecifications: [{ key: "RAM", value: "8GB" }],
        variantLabels: ["Black 128GB"],
        suspectedAnomalyReasons: ["Price abnormally low"],
        evidence: [{ id: "e-1", text: "MSRP mismatch" }],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(() => provider.complete(anomalyReq), /DRY_RUN mode/);

    // 4. PARSER_RECOVERY_SUGGESTION (with optional fields)
    const recoveryReq = createSampleRequest({
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      untrustedData: {
        taskKind: "PARSER_RECOVERY_SUGGESTION",
        urlPath: "/p/product-detail-456",
        diagnosticLabels: ["PRICE_LABEL_SHIFTED"],
        failureSignals: ["price_selector_not_found"],
        suspectedDomMarkers: [".product-price-v2"],
        evidence: [{ id: "e-1", text: "DOM markup changed in release" }],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(() => provider.complete(recoveryReq), /DRY_RUN mode/);
  });

  it("rejects unknown keys, wrong optional types, and sparse arrays in privacy gate", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Unknown top-level key in untrustedData
    const unknownTopKeyReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Product",
        unknownField: "bad",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(unknownTopKeyReq),
      /Unknown property 'unknownField'/
    );

    // Optional field wrong type (brand as number)
    const wrongTypeReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Product",
        brand: 12345 as any,
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(wrongTypeReq),
      /brand must be a non-blank string/
    );

    // Sparse categoryHints
    const sparseHints: string[] = ["Hint1"];
    sparseHints[2] = "Hint2";
    const sparseHintReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Product",
        categoryHints: sparseHints,
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(sparseHintReq),
      /Sparse array hole/
    );

    // Candidate unknown key
    const badCandidateReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Product",
        candidates: [{ id: "c-1", name: "C1", unknownProp: "bad" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(badCandidateReq),
      /contains unknown property 'unknownProp'/
    );

    // Non-mapping task with candidates
    const nonMappingWithCandidatesReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Product",
        selectedCategoryPath: "Path",
        evidence: [{ id: "e-1", text: "E1" }],
      },
      allowedCandidateIds: ["c-1"],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(nonMappingWithCandidatesReq),
      /must have empty allowedCandidateIds/
    );
  });

  it("accepts benign string values containing security words", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    const benignReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "USB Security Token Hardware Key with Password Manager",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "Includes secret key generation feature" }],
      },
    });

    await assert.rejects(
      async () => provider.complete(benignReq),
      /DRY_RUN mode; network dispatch simulated safely/
    );
  });

  it("rejects missing taskKind, taskKind mismatch, and allowlist mismatches", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Missing taskKind in untrustedData
    const missingTaskKindReq = createSampleRequest();
    delete (missingTaskKindReq.untrustedData as any).taskKind;
    await assert.rejects(
      async () => provider.complete(missingTaskKindReq),
      /UntrustedData taskKind.*does not match request taskKind/
    );

    // Mismatched taskKind
    const mismatchReq = createSampleRequest({
      untrustedData: {
        ...createSampleRequest().untrustedData,
        taskKind: "ATTRIBUTE_MAPPING" as any,
      },
    });
    await assert.rejects(
      async () => provider.complete(mismatchReq),
      /UntrustedData taskKind.*does not match request taskKind/
    );

    // Candidate ID allowlist mismatch
    const candidateMismatchReq = createSampleRequest({
      allowedCandidateIds: ["c-1", "c-99"],
    });
    await assert.rejects(
      async () => provider.complete(candidateMismatchReq),
      /Candidate ID mismatch/
    );

    // Evidence ID allowlist mismatch
    const evidenceMismatchReq = createSampleRequest({
      allowedEvidenceIds: ["e-99"],
    });
    await assert.rejects(
      async () => provider.complete(evidenceMismatchReq),
      /Evidence ID mismatch/
    );
  });

  it("rejects nested forbidden property keys anywhere in structural hierarchy", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Forbidden nested in object
    const forbiddenInObjectReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Valid Title",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
        metadata: { apiKey: "secret-key-value" },
      } as any,
    });
    await assert.rejects(
      async () => provider.complete(forbiddenInObjectReq),
      /Forbidden structural property name 'apiKey'/
    );

    // Forbidden nested in array item
    const forbiddenInArrayReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Valid Title",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
        items: [{ token: "secret-token-value" }],
      } as any,
    });
    await assert.rejects(
      async () => provider.complete(forbiddenInArrayReq),
      /Forbidden structural property name 'token'/
    );
  });

  it("rejects sparse arrays across all canonical arrays and sub-arrays", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // 1. Sparse candidates
    const sparseCandidates: any[] = [{ id: "c-1", name: "C1" }];
    sparseCandidates[2] = { id: "c-2", name: "C2" };
    const sparseCandidatesReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Valid Title",
        candidates: sparseCandidates,
        evidence: [{ id: "e-1", text: "E1" }],
      },
      allowedCandidateIds: ["c-1", "c-2"],
    });
    await assert.rejects(
      async () => provider.complete(sparseCandidatesReq),
      /candidates must be a dense array|CATEGORY_MAPPING untrustedData missing required canonical fields|Sparse array hole/
    );

    // 2. Sparse evidence
    const sparseEvidence: any[] = [{ id: "e-1", text: "E1" }];
    sparseEvidence[2] = { id: "e-2", text: "E2" };
    const sparseEvidenceReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Valid Title",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: sparseEvidence,
      },
      allowedEvidenceIds: ["e-1", "e-2"],
    });
    await assert.rejects(
      async () => provider.complete(sparseEvidenceReq),
      /evidence must be a dense array|CATEGORY_MAPPING untrustedData missing required canonical fields|Sparse array hole/
    );

    // 3. Sparse sourceSpecifications in ANOMALY_REVIEW
    const sparseSpecs: any[] = [{ key: "k1", value: "v1" }];
    sparseSpecs[2] = { key: "k2", value: "v2" };
    const sparseSpecsReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Title",
        selectedCategoryPath: "Path",
        evidence: [{ id: "e-1", text: "E1" }],
        sourceSpecifications: sparseSpecs,
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseSpecsReq),
      /sourceSpecifications must be a dense array|Sparse array hole/
    );

    // 4. Sparse variantLabels in ANOMALY_REVIEW
    const sparseVariants: string[] = ["v1"];
    sparseVariants[2] = "v2";
    const sparseVariantsReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Title",
        selectedCategoryPath: "Path",
        evidence: [{ id: "e-1", text: "E1" }],
        variantLabels: sparseVariants,
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseVariantsReq),
      /variantLabels must be a dense non-blank string array|Sparse array hole/
    );

    // 5. Sparse suspectedAnomalyReasons in ANOMALY_REVIEW
    const sparseReasons: string[] = ["r1"];
    sparseReasons[2] = "r2";
    const sparseReasonsReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Title",
        selectedCategoryPath: "Path",
        evidence: [{ id: "e-1", text: "E1" }],
        suspectedAnomalyReasons: sparseReasons,
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseReasonsReq),
      /suspectedAnomalyReasons must be a dense non-blank string array|Sparse array hole/
    );

    // 6. Sparse diagnosticLabels in PARSER_RECOVERY_SUGGESTION
    const sparseDiagnostics: string[] = ["d1"];
    sparseDiagnostics[2] = "d2";
    const sparseDiagnosticsReq = createSampleRequest({
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      untrustedData: {
        taskKind: "PARSER_RECOVERY_SUGGESTION",
        urlPath: "/product/item-1",
        diagnosticLabels: sparseDiagnostics,
        failureSignals: ["f1"],
        evidence: [{ id: "e-1", text: "E1" }],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseDiagnosticsReq),
      /PARSER_RECOVERY_SUGGESTION untrustedData missing required canonical fields|Sparse array hole/
    );

    // 7. Sparse failureSignals in PARSER_RECOVERY_SUGGESTION
    const sparseSignals: string[] = ["f1"];
    sparseSignals[2] = "f2";
    const sparseSignalsReq = createSampleRequest({
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      untrustedData: {
        taskKind: "PARSER_RECOVERY_SUGGESTION",
        urlPath: "/product/item-1",
        diagnosticLabels: ["d1"],
        failureSignals: sparseSignals,
        evidence: [{ id: "e-1", text: "E1" }],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseSignalsReq),
      /PARSER_RECOVERY_SUGGESTION untrustedData missing required canonical fields|Sparse array hole/
    );

    // 8. Sparse suspectedDomMarkers in PARSER_RECOVERY_SUGGESTION
    const sparseMarkers: string[] = ["m1"];
    sparseMarkers[2] = "m2";
    const sparseMarkersReq = createSampleRequest({
      taskKind: "PARSER_RECOVERY_SUGGESTION",
      untrustedData: {
        taskKind: "PARSER_RECOVERY_SUGGESTION",
        urlPath: "/product/item-1",
        diagnosticLabels: ["d1"],
        failureSignals: ["f1"],
        suspectedDomMarkers: sparseMarkers,
        evidence: [{ id: "e-1", text: "E1" }],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(sparseMarkersReq),
      /suspectedDomMarkers must be a dense non-blank string array|Sparse array hole/
    );
  });

  it("rejects unknown keys in nested structures and rejects inherited fields", async () => {
    const config = resolveLiveProviderConfig({ mode: "DRY_RUN" });
    const provider = new LiveAiProvider(config, null);

    // Evidence with unknown key
    const badEvidenceReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Product",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1", extraKey: "bad" } as any],
      },
    });
    await assert.rejects(
      async () => provider.complete(badEvidenceReq),
      /must contain exactly 'id' and 'text'/
    );

    // Specification with unknown key
    const badSpecReq = createSampleRequest({
      taskKind: "ANOMALY_REVIEW",
      untrustedData: {
        taskKind: "ANOMALY_REVIEW",
        productTitle: "Product",
        selectedCategoryPath: "Path",
        evidence: [{ id: "e-1", text: "E1" }],
        sourceSpecifications: [{ key: "k", value: "v", extraKey: "bad" } as any],
      },
      allowedCandidateIds: [],
      allowedEvidenceIds: ["e-1"],
    });
    await assert.rejects(
      async () => provider.complete(badSpecReq),
      /must contain exactly 'key' and 'value'/
    );

    // UntrustedData with inherited canonical required field (productTitle)
    const untrustedProto = { productTitle: "Inherited Title" };
    const untrustedDataInherited = Object.assign(Object.create(untrustedProto), {
      taskKind: "CATEGORY_MAPPING",
      candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
      evidence: [{ id: "e-1", text: "E1" }],
    });
    const inheritedCanonicalReq = createSampleRequest({ untrustedData: untrustedDataInherited });
    await assert.rejects(
      async () => provider.complete(inheritedCanonicalReq),
      /CATEGORY_MAPPING untrustedData missing required canonical fields/
    );

    // Candidate with inherited required field (id)
    const candidateProto = { id: "c-1" };
    const candidateInherited = Object.assign(Object.create(candidateProto), { name: "C1" });
    const candidateInheritedReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Title",
        candidates: [candidateInherited, { id: "c-2", name: "C2" }],
        evidence: [{ id: "e-1", text: "E1" }],
      },
    });
    await assert.rejects(
      async () => provider.complete(candidateInheritedReq),
      /Candidate at index 0 missing required non-blank string 'id'/
    );

    // Evidence with inherited required field (text)
    const evidenceProto = { text: "E1" };
    const evidenceInherited = Object.assign(Object.create(evidenceProto), { id: "e-1" });
    const evidenceInheritedReq = createSampleRequest({
      untrustedData: {
        taskKind: "CATEGORY_MAPPING",
        productTitle: "Title",
        candidates: [{ id: "c-1", name: "C1" }, { id: "c-2", name: "C2" }],
        evidence: [evidenceInherited],
      },
    });
    await assert.rejects(
      async () => provider.complete(evidenceInheritedReq),
      /must contain exactly 'id' and 'text'/
    );
  });
});

describe("Phase 5E: Request Body & Headers Strict Responses API Protocol", () => {
  it("verifies exact Responses API payload, model, strict schema, and absence of legacy fields", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    let capturedInit: any = null;

    const transport = createFakeTransport(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        createMockResponseJson(JSON.stringify({
          schemaVersion: 1,
          taskKind: "CATEGORY_MAPPING",
          selectedCandidateId: "c-1",
          confidence: 0.95,
          explanationSummary: "Match found",
          evidenceRefs: ["e-1"],
        })),
        { status: 200 }
      );
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      maxOutputTokens: 750,
    });
    const provider = new LiveAiProvider(config, "valid-secret-key", { transport });
    const req = createSampleRequest();

    const result = await provider.complete(req);
    assert.deepEqual(Object.keys(result), ["rawText"]);

    // Transport initialization checks
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.redirect, "error");
    assert.equal(capturedInit.signal, req.signal);

    // Protocol check
    assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
    assert.equal(capturedHeaders["Authorization"], "Bearer valid-secret-key");
    assert.equal(capturedHeaders["Content-Type"], "application/json");

    // Exact payload fields
    assert.equal(capturedBody.model, "gpt-5.6-luna");
    assert.equal(capturedBody.instructions, req.systemInstruction);
    assert.equal(capturedBody.input, req.prompt);
    assert.equal(capturedBody.store, false);
    assert.equal(capturedBody.max_output_tokens, 750);
    assert.equal(capturedBody.truncation, "disabled");
    assert.deepEqual(capturedBody.reasoning, { effort: "none" });

    // Exact json_schema format
    assert.equal(capturedBody.text.format.type, "json_schema");
    assert.equal(capturedBody.text.format.name, "semantic_intelligence_response");
    assert.equal(capturedBody.text.format.strict, true);

    const schema = capturedBody.text.format.schema;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.properties.schemaVersion.enum, [1]);
    assert.deepEqual(schema.properties.taskKind.enum, [req.taskKind]);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, [
      "schemaVersion",
      "taskKind",
      "selectedCandidateId",
      "confidence",
      "explanationSummary",
      "evidenceRefs",
    ]);

    // Forbidden legacy fields absence
    assert.equal("messages" in capturedBody, false);
    assert.equal("response_format" in capturedBody, false);
    assert.equal("max_tokens" in capturedBody, false);
    assert.equal("temperature" in capturedBody, false);
    assert.equal("tools" in capturedBody, false);
    assert.equal("previous_response_id" in capturedBody, false);
    assert.equal("conversation" in capturedBody, false);
    assert.equal("background" in capturedBody, false);
    assert.equal("metadata" in capturedBody, false);
  });
});

describe("Phase 5E: Abort Accounting & Process Budget Bounds", () => {
  it("pre-dispatch abort check consumes zero dispatches, rate slots, and circuit health", async () => {
    let transportCalled = false;
    const transport = createFakeTransport(async () => {
      transportCalled = true;
      return new Response("{}", { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });

    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    const req = createSampleRequest({ signal: controller.signal });

    await assert.rejects(
      async () => provider.complete(req),
      /aborted before dispatch/
    );

    assert.equal(transportCalled, false);
    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.completeCalls, 1);
    assert.equal(snapshot.networkDispatches, 0);
    assert.equal(snapshot.failedNetworkResponses, 0);
    assert.equal(snapshot.rateLimitBlocked, 0);
    assert.equal(snapshot.circuitBlocked, 0);
  });

  it("post-dispatch abort records dispatch, failure, and health impact without retry", async () => {
    let transportCallCount = 0;
    const controller = new AbortController();

    const transport = createFakeTransport(async (_url, init) => {
      transportCallCount++;
      // Abort after dispatch initiated
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest({ signal: controller.signal });

    await assert.rejects(
      async () => provider.complete(req),
      /OpenAI provider request was aborted\./
    );

    assert.equal(transportCallCount, 1); // No retry
    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
  });

  it("enforces maxRequestsPerProcess ceiling", async () => {
    let transportCount = 0;
    const transport = createFakeTransport(async () => {
      transportCount++;
      return new Response(
        createMockResponseJson(JSON.stringify({
          schemaVersion: 1,
          taskKind: "CATEGORY_MAPPING",
          selectedCandidateId: "c-1",
          confidence: 0.9,
          explanationSummary: "OK",
          evidenceRefs: ["e-1"],
        })),
        { status: 200 }
      );
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      maxRequestsPerProcess: 2,
    });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    // Call 1
    await provider.complete(req);
    // Call 2
    await provider.complete(req);
    assert.equal(transportCount, 2);

    // Call 3: Exceeds process budget
    await assert.rejects(
      async () => provider.complete(req),
      /process request budget exceeded/
    );

    assert.equal(transportCount, 2); // Zero 3rd fetch
    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.budgetBlocked, 1);
    assert.equal(snapshot.networkDispatches, 2);
  });

  it("proves failed fetch/HTTP dispatches consume network dispatches, process budget, and rate slots", async () => {
    let attempts = 0;
    const transport = createFakeTransport(async () => {
      attempts++;
      if (attempts === 1) {
        return new Response("Server error", { status: 500 });
      }
      throw new Error("Network transport failure");
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      maxRequestsPerProcess: 2,
      maxRequestsPerWindow: 10,
      failureThreshold: 5,
    });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    // Call 1: HTTP 500 consumes 1 dispatch, 1 process slot
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    assert.equal(attempts, 1);

    // Call 2: Network error consumes 1 dispatch, 1 process slot
    await assert.rejects(() => provider.complete(req), /network transport failed/);
    assert.equal(attempts, 2);

    // Call 3: Exceeds maxRequestsPerProcess (2) -> fast-fails before dispatch (zero fetch)
    await assert.rejects(() => provider.complete(req), /process request budget exceeded/);
    assert.equal(attempts, 2);

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 2);
    assert.equal(snapshot.budgetBlocked, 1);
  });
});

describe("Phase 5E: Rate Limiter & Circuit Breaker Concurrency", () => {
  it("rate limiter counts failed dispatches and blocks before process budget", async () => {
    const clock = new FakeClock();
    let networkAttempts = 0;
    const transport = createFakeTransport(async () => {
      networkAttempts++;
      return new Response("Server error", { status: 500 });
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      maxRequestsPerWindow: 1,
      windowMs: 60000,
      failureThreshold: 5,
    });
    const provider = new LiveAiProvider(config, "valid-key", { clock, transport });
    const req = createSampleRequest();

    // Call 1: Dispatches and fails HTTP 500, but consumed rate slot
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    assert.equal(networkAttempts, 1);

    // Call 2: Rate limited immediately (zero fetch)
    await assert.rejects(() => provider.complete(req), /rate limit exceeded/);
    assert.equal(networkAttempts, 1);
    assert.equal(provider.getUsageSnapshot().rateLimitBlocked, 1);

    // Advance clock past window
    clock.advanceMs(60001);

    // Call 3: Dispatches again
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    assert.equal(networkAttempts, 2);
  });

  it("circuit breaker: allows one probe in HALF_OPEN and blocks concurrent probe", async () => {
    const clock = new FakeClock();
    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      failureThreshold: 2,
      cooldownMs: 30000,
    });

    let returnStatus = 500;
    let resolveProbePromise!: (res: Response) => void;

    let probeInFlight = false;
    const transport = createFakeTransport(async () => {
      if (returnStatus === 500) {
        return new Response("Error", { status: 500 });
      }
      if (probeInFlight) {
        return new Promise<Response>((resolve) => {
          resolveProbePromise = resolve;
        });
      }
      return new Response(
        createMockResponseJson(JSON.stringify({
          schemaVersion: 1,
          taskKind: "CATEGORY_MAPPING",
          selectedCandidateId: "c-1",
          confidence: 0.9,
          explanationSummary: "OK",
          evidenceRefs: ["e-1"],
        })),
        { status: 200 }
      );
    });

    const provider = new LiveAiProvider(config, "valid-key", { clock, transport });
    const req = createSampleRequest();

    // 2 failures trip circuit to OPEN
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    await assert.rejects(() => provider.complete(req), /HTTP 500/);

    // Fast-fails while OPEN
    await assert.rejects(() => provider.complete(req), /circuit is OPEN/);

    // Advance clock to allow probe
    clock.advanceMs(30001);
    returnStatus = 200;
    probeInFlight = true;

    // Issue Probe 1: Starts and remains in-flight waiting for deferred resolve
    const probe1Promise = provider.complete(req);

    // While Probe 1 is in flight, Probe 2 attempts to dispatch
    await assert.rejects(
      async () => provider.complete(req),
      /circuit is OPEN/
    );
    assert.equal(provider.getUsageSnapshot().circuitBlocked, 2);

    // Now resolve Probe 1 successfully
    resolveProbePromise(
      new Response(
        createMockResponseJson(JSON.stringify({
          schemaVersion: 1,
          taskKind: "CATEGORY_MAPPING",
          selectedCandidateId: "c-1",
          confidence: 0.9,
          explanationSummary: "OK",
          evidenceRefs: ["e-1"],
        })),
        { status: 200 }
      )
    );

    const probe1Result = await probe1Promise;
    assert(probe1Result.rawText.includes("OK"));

    // Circuit is now CLOSED
    probeInFlight = false;
    const nextResult = await provider.complete(req);
    assert(nextResult.rawText.includes("OK"));
  });

  it("circuit breaker: HTTP 400 and 401 do not trip circuit, but 429 and 500 do", async () => {
    let returnStatus = 400;
    const transport = createFakeTransport(async () => {
      return new Response("Client Error", { status: returnStatus });
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      failureThreshold: 2,
    });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    // 2x HTTP 400
    await assert.rejects(() => provider.complete(req), /HTTP 400/);
    await assert.rejects(() => provider.complete(req), /HTTP 400/);
    // Circuit still not OPEN
    assert.equal(provider.getUsageSnapshot().circuitBlocked, 0);

    // 2x HTTP 401
    returnStatus = 401;
    await assert.rejects(() => provider.complete(req), /HTTP 401/);
    await assert.rejects(() => provider.complete(req), /HTTP 401/);
    // Circuit still not OPEN
    assert.equal(provider.getUsageSnapshot().circuitBlocked, 0);

    // 2x HTTP 429 -> Trips circuit
    returnStatus = 429;
    await assert.rejects(() => provider.complete(req), /HTTP 429/);
    await assert.rejects(() => provider.complete(req), /HTTP 429/);

    // Now circuit is OPEN
    await assert.rejects(() => provider.complete(req), /circuit is OPEN/);
    assert.equal(provider.getUsageSnapshot().circuitBlocked, 1);
  });

  it("circuit breaker: network transport rejection causes health failure and trips circuit", async () => {
    let networkAttempts = 0;
    const transport = createFakeTransport(async () => {
      networkAttempts++;
      throw new Error("Network connection dropped");
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      failureThreshold: 2,
    });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    // Failure 1
    await assert.rejects(() => provider.complete(req), /network transport failed/);
    assert.equal(networkAttempts, 1);

    // Failure 2 -> Trips circuit
    await assert.rejects(() => provider.complete(req), /network transport failed/);
    assert.equal(networkAttempts, 2);

    // Call 3 -> Circuit OPEN (zero fetch)
    await assert.rejects(() => provider.complete(req), /circuit is OPEN/);
    assert.equal(networkAttempts, 2);
    assert.equal(provider.getUsageSnapshot().circuitBlocked, 1);
  });

  it("circuit breaker: HALF_OPEN probe failure transitions and non-health probe recovery", async () => {
    const clock = new FakeClock();
    let currentStatus = 500;
    let transportCalls = 0;

    const transport = createFakeTransport(async () => {
      transportCalls++;
      if (currentStatus === 200) {
        return new Response(
          createMockResponseJson(JSON.stringify({
            schemaVersion: 1,
            taskKind: "CATEGORY_MAPPING",
            selectedCandidateId: "c-1",
            confidence: 0.9,
            explanationSummary: "OK",
            evidenceRefs: ["e-1"],
          })),
          { status: 200 }
        );
      }
      return new Response("Upstream Error", { status: currentStatus });
    });

    const config = resolveLiveProviderConfig({
      mode: "LIVE",
      failureThreshold: 2,
      cooldownMs: 30000,
    });
    const provider = new LiveAiProvider(config, "valid-key", { clock, transport });
    const req = createSampleRequest();

    // 2x 500 trips circuit to OPEN
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    assert.equal(transportCalls, 2);

    // In OPEN: fast-fails
    await assert.rejects(() => provider.complete(req), /circuit is OPEN/);
    assert.equal(transportCalls, 2);

    // Advance clock past cooldown: allows probe
    clock.advanceMs(30001);

    // 1. Non-health failure during probe (HTTP 400): probe lock released, no deadlock
    currentStatus = 400;
    await assert.rejects(() => provider.complete(req), /HTTP 400/);
    assert.equal(transportCalls, 3);

    // Subsequent call is admitted without deadlock (probe flag was cleared)
    currentStatus = 500;
    await assert.rejects(() => provider.complete(req), /HTTP 500/);
    assert.equal(transportCalls, 4);

    // That health failure in HALF_OPEN transitioned back to OPEN and restarted cooldown
    await assert.rejects(() => provider.complete(req), /circuit is OPEN/);
    assert.equal(transportCalls, 4);

    // Advance clock again past restarted cooldown: probe admitted and succeeds
    clock.advanceMs(30001);
    currentStatus = 200;
    const result = await provider.complete(req);
    assert.equal(transportCalls, 5);
    assert(result.rawText.includes("OK"));
  });
});

describe("Phase 5E: Responses Status & Output Array Comprehensive Coverage", () => {
  it("rejects non-plain JSON responses (null, array, class instance, symbol keys)", async () => {
    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const req = createSampleRequest();

    // Array root
    let transport = createFakeTransport(async () => new Response("[]", { status: 200 }));
    let provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /response was malformed/);

    // null root
    transport = createFakeTransport(async () => new Response("null", { status: 200 }));
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /response was malformed/);
  });

  it("handles all Responses API statuses with fixed error messages without leaking raw status", async () => {
    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const req = createSampleRequest();

    // incomplete with max_output_tokens
    let transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        status: "incomplete",
        incompleteReason: "max_output_tokens",
      }), { status: 200 });
    });
    let provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /max_output_tokens exceeded/);

    // incomplete without max_output_tokens
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        status: "incomplete",
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(
      () => provider.complete(req),
      (err: any) => err.message === "OpenAI provider response was incomplete."
    );

    // non-completed statuses: failed, cancelled, queued, in_progress, unknown
    const statuses = ["failed", "cancelled", "queued", "in_progress", "MALICIOUS_STATUS_123"];
    for (const status of statuses) {
      transport = createFakeTransport(async () => {
        return new Response(createMockResponseJson("{}", { status }), { status: 200 });
      });
      provider = new LiveAiProvider(config, "valid-key", { transport });
      await assert.rejects(
        () => provider.complete(req),
        (err: any) => {
          assert.equal(err.message, "OpenAI provider response was not completed.");
          assert.equal(err.message.includes(status), false); // No interpolation of raw status
          return true;
        }
      );
    }
  });

  it("covers full output array matrix (missing, sparse, tools, assistant count/status, refusal)", async () => {
    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const req = createSampleRequest();

    // Missing output
    let transport = createFakeTransport(async () => {
      return new Response(JSON.stringify({ object: "response", status: "completed" }), { status: 200 });
    });
    let provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Non-array output
    transport = createFakeTransport(async () => {
      return new Response(JSON.stringify({ object: "response", status: "completed", output: {} }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Sparse output
    transport = createFakeTransport(async () => {
      const arr = [];
      arr[1] = { type: "message", role: "assistant", status: "completed", content: [] };
      return new Response(JSON.stringify({ object: "response", status: "completed", output: arr }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Tool item in output
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{ type: "function_call", name: "bad" }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Two assistant messages
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [
          { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "1" }] },
          { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "2" }] },
        ],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Assistant wrong role
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{ type: "message", role: "user", status: "completed", content: [] }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Assistant wrong status
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{ type: "message", role: "assistant", status: "in_progress", content: [] }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Refusal content item
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: "I cannot assist." }],
        }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Zero output_text
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [],
        }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Blank output_text
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "   " }],
        }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);

    // Two output_text items
    transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Text 1" },
            { type: "output_text", text: "Text 2" },
          ],
        }],
      }), { status: 200 });
    });
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /output was invalid/);
  });

  it("rejects adversarial response structures using custom injected json()", async () => {
    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const req = createSampleRequest();

    const validAssistantMessage = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "valid text" }],
    };

    // 1. Class instance root
    class ClassInstanceRoot {
      object = "response";
      status = "completed";
      output = [validAssistantMessage];
    }
    let transport = createFakeTransport(async () => createCustomResponse(new ClassInstanceRoot()));
    let provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response was malformed\./);

    // 2. Symbol-keyed root
    const symbolKeyedRoot = {
      [Symbol("adversarial")]: true,
      object: "response",
      status: "completed",
      output: [validAssistantMessage],
    };
    transport = createFakeTransport(async () => createCustomResponse(symbolKeyedRoot));
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response was malformed\./);

    // 3. Inherited root required property ('object' inherited)
    const protoObject = { object: "response" };
    const inheritedObjectRoot = Object.assign(Object.create(protoObject), {
      status: "completed",
      output: [validAssistantMessage],
    });
    transport = createFakeTransport(async () => createCustomResponse(inheritedObjectRoot));
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response was malformed\./);

    // 4. Inherited root required property ('status' inherited)
    const protoStatus = { status: "completed" };
    const inheritedStatusRoot = Object.assign(Object.create(protoStatus), {
      object: "response",
      output: [validAssistantMessage],
    });
    transport = createFakeTransport(async () => createCustomResponse(inheritedStatusRoot));
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response was malformed\./);

    // 5. Root error non-null: throws fixed message and does not echo error content
    const rootErrorObj = {
      object: "response",
      status: "completed",
      error: { message: "MALICIOUS_ROOT_ERROR_PAYLOAD" },
      output: [validAssistantMessage],
    };
    transport = createFakeTransport(async () => createCustomResponse(rootErrorObj));
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider response contained an error.");
        assert.equal(err.message.includes("MALICIOUS_ROOT_ERROR_PAYLOAD"), false);
        return true;
      }
    );

    // 6. Primitive output item
    transport = createFakeTransport(async () =>
      createCustomResponse({
        object: "response",
        status: "completed",
        output: ["primitive-item-string"],
      })
    );
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response output was invalid\./);

    // 7. Genuine sparse output array from custom json()
    const sparseOutputArr: unknown[] = [];
    sparseOutputArr[1] = validAssistantMessage;
    transport = createFakeTransport(async () =>
      createCustomResponse({
        object: "response",
        status: "completed",
        output: sparseOutputArr,
      })
    );
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response output was invalid\./);

    // 8. Content non-array
    transport = createFakeTransport(async () =>
      createCustomResponse({
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: "not-an-array",
        }],
      })
    );
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response output was invalid\./);

    // 9. Genuine sparse content array from custom json()
    const sparseContentArr: unknown[] = [];
    sparseContentArr[1] = { type: "output_text", text: "valid text" };
    transport = createFakeTransport(async () =>
      createCustomResponse({
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: sparseContentArr,
        }],
      })
    );
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response output was invalid\./);

    // 10. Unexpected content type (e.g. image_url)
    transport = createFakeTransport(async () =>
      createCustomResponse({
        object: "response",
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "image_url", url: "https://example.com/photo.png" }],
        }],
      })
    );
    provider = new LiveAiProvider(config, "valid-key", { transport });
    await assert.rejects(() => provider.complete(req), /OpenAI provider response output was invalid\./);
  });
});

describe("Phase 5E: Authoritative Usage & Secret Leakage Prevention", () => {
  it("records authoritative usage and tracks missing usage correctly", async () => {
    let returnUsage: any = { input_tokens: 120, output_tokens: 45, total_tokens: 165 };
    const transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        usage: returnUsage,
      }), { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    // Call 1: Authoritative usage reported
    await provider.complete(req);
    const s1 = provider.getUsageSnapshot();
    assert.equal(s1.usageReportedRequests, 1);
    assert.equal(s1.usageMissingRequests, 0);
    assert.equal(s1.reportedInputTokens, 120);
    assert.equal(s1.reportedOutputTokens, 45);
    assert.equal(s1.reportedTotalTokens, 165);

    // Call 2: Usage missing from response
    returnUsage = undefined;
    await provider.complete(req);
    const s2 = provider.getUsageSnapshot();
    assert.equal(s2.usageReportedRequests, 1);
    assert.equal(s2.usageMissingRequests, 1);
    assert.equal(s2.reportedInputTokens, 120); // Subtotals unchanged
    assert.equal(s2.reportedOutputTokens, 45); // Subtotals unchanged
    assert.equal(s2.reportedTotalTokens, 165); // Subtotals unchanged
  });

  it("rejects malformed usage structures without mutating token counters", async () => {
    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const req = createSampleRequest();

    const validAssistantMessage = {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "valid text" }],
    };

    const testMalformedUsage = async (usageObj: unknown) => {
      const transport = createFakeTransport(async () => {
        return createCustomResponse({
          object: "response",
          status: "completed",
          usage: usageObj,
          output: [validAssistantMessage],
        });
      });
      const provider = new LiveAiProvider(config, "valid-key", { transport });
      await assert.rejects(
        () => provider.complete(req),
        /OpenAI provider usage response was malformed\./
      );
      const snapshot = provider.getUsageSnapshot();
      assert.equal(snapshot.usageReportedRequests, 0);
      assert.equal(snapshot.reportedInputTokens, 0);
      assert.equal(snapshot.reportedOutputTokens, 0);
      assert.equal(snapshot.reportedTotalTokens, 0);
    };

    // 1. Negative tokens
    await testMalformedUsage({ input_tokens: -5, output_tokens: 10, total_tokens: 5 });
    // 2. Non-integer tokens
    await testMalformedUsage({ input_tokens: 5.5, output_tokens: 10, total_tokens: 15.5 });
    // 3. NaN tokens (injected directly via custom json())
    await testMalformedUsage({ input_tokens: NaN, output_tokens: 10, total_tokens: 10 });
    // 4. Infinity tokens
    await testMalformedUsage({ input_tokens: Infinity, output_tokens: 10, total_tokens: Infinity });
    // 5. Non-plain object (class instance)
    class CustomUsage {
      input_tokens = 10;
      output_tokens = 20;
      total_tokens = 30;
    }
    await testMalformedUsage(new CustomUsage());
    // 6. Symbol-keyed usage object
    await testMalformedUsage({
      [Symbol("sym")]: "bad",
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
    });
    // 7. Inherited token properties
    const protoUsage = { input_tokens: 10 };
    const inheritedUsage = Object.assign(Object.create(protoUsage), {
      output_tokens: 20,
      total_tokens: 30,
    });
    await testMalformedUsage(inheritedUsage);
  });

  it("records authoritative usage on incomplete max_output_tokens responses without returning partial output", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens",
        },
        usage: {
          input_tokens: 120,
          output_tokens: 800,
          total_tokens: 920,
        },
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "partial output" }],
        }],
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(
          err.message,
          "OpenAI provider response incomplete: max_output_tokens exceeded."
        );
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 1);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 120);
    assert.equal(snapshot.reportedOutputTokens, 800);
    assert.equal(snapshot.reportedTotalTokens, 920);
  });

  it("records authoritative usage on non-completed failed status responses", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "failed",
        usage: {
          input_tokens: 150,
          output_tokens: 50,
          total_tokens: 200,
        },
        output: [],
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider response was not completed.");
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 1);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 150);
    assert.equal(snapshot.reportedOutputTokens, 50);
    assert.equal(snapshot.reportedTotalTokens, 200);
  });

  it("fails closed without mutating token counters when incomplete response has malformed usage", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "incomplete",
        incomplete_details: {
          reason: "max_output_tokens",
        },
        usage: {
          input_tokens: -10,
          output_tokens: 800,
          total_tokens: 790,
        },
        output: [],
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      /OpenAI provider usage response was malformed\./
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 0);
    assert.equal(snapshot.reportedOutputTokens, 0);
    assert.equal(snapshot.reportedTotalTokens, 0);
  });

  it("records authoritative usage when response is completed but output is invalid", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 75,
          total_tokens: 175,
        },
        output: "not-an-array",
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      /OpenAI provider response output was invalid\./
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 1);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 100);
    assert.equal(snapshot.reportedOutputTokens, 75);
    assert.equal(snapshot.reportedTotalTokens, 175);
  });

  it("records authoritative usage on failed response with non-null error without leaking error payload", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "failed",
        error: {
          code: "server_error",
          message: "RAW_PROVIDER_ERROR_MUST_NOT_LEAK",
        },
        usage: {
          input_tokens: 120,
          output_tokens: 40,
          total_tokens: 160,
        },
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider response contained an error.");
        assert.equal(err.message.includes("RAW_PROVIDER_ERROR_MUST_NOT_LEAK"), false);
        assert.equal(err.message.includes("server_error"), false);
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 1);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 120);
    assert.equal(snapshot.reportedOutputTokens, 40);
    assert.equal(snapshot.reportedTotalTokens, 160);
  });

  it("records missing usage without fabricating zero tokens on failed response with non-null error", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "failed",
        error: {
          code: "server_error",
          message: "RAW_PROVIDER_ERROR_MUST_NOT_LEAK",
        },
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider response contained an error.");
        assert.equal(err.message.includes("RAW_PROVIDER_ERROR_MUST_NOT_LEAK"), false);
        assert.equal(err.message.includes("server_error"), false);
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 0);
    assert.equal(snapshot.usageMissingRequests, 1);
    assert.equal(snapshot.reportedInputTokens, 0);
    assert.equal(snapshot.reportedOutputTokens, 0);
    assert.equal(snapshot.reportedTotalTokens, 0);
  });

  it("fails closed on malformed usage before error evaluation and increments failedNetworkResponses once", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "failed",
        error: {
          code: "server_error",
          message: "RAW_PROVIDER_ERROR_MUST_NOT_LEAK",
        },
        usage: {
          input_tokens: -10,
          output_tokens: 40,
          total_tokens: 30,
        },
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider usage response was malformed.");
        assert.equal(err.message.includes("RAW_PROVIDER_ERROR_MUST_NOT_LEAK"), false);
        assert.equal(err.message.includes("server_error"), false);
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 0);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 0);
    assert.equal(snapshot.reportedOutputTokens, 0);
    assert.equal(snapshot.reportedTotalTokens, 0);
  });

  it("records authoritative usage on inconsistent completed response with non-null error and fails closed", async () => {
    const transport = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "completed",
        error: {
          code: "server_error",
          message: "RAW_PROVIDER_ERROR_MUST_NOT_LEAK",
        },
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
        output: [],
      }, 200);
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "valid-key", { transport });
    const req = createSampleRequest();

    await assert.rejects(
      () => provider.complete(req),
      (err: any) => {
        assert.equal(err.message, "OpenAI provider response contained an error.");
        assert.equal(err.message.includes("RAW_PROVIDER_ERROR_MUST_NOT_LEAK"), false);
        assert.equal(err.message.includes("server_error"), false);
        return true;
      }
    );

    const snapshot = provider.getUsageSnapshot();
    assert.equal(snapshot.networkDispatches, 1);
    assert.equal(snapshot.failedNetworkResponses, 1);
    assert.equal(snapshot.successfulNetworkResponses, 0);
    assert.equal(snapshot.usageReportedRequests, 1);
    assert.equal(snapshot.usageMissingRequests, 0);
    assert.equal(snapshot.reportedInputTokens, 100);
    assert.equal(snapshot.reportedOutputTokens, 50);
    assert.equal(snapshot.reportedTotalTokens, 150);
  });

  it("usage snapshot is frozen and contains zero sensitive secrets or text", async () => {
    const transport = createFakeTransport(async () => {
      return new Response(createMockResponseJson("{}", {
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      }), { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider = new LiveAiProvider(config, "secret-key", { transport });
    await provider.complete(createSampleRequest());

    const snapshot = provider.getUsageSnapshot();
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal("apiKey" in snapshot, false);
    assert.equal("prompt" in snapshot, false);
    assert.equal("systemInstruction" in snapshot, false);
    assert.equal("untrustedData" in snapshot, false);
    assert.equal("rawText" in snapshot, false);
  });

  it("guarantees sentinel secrets are never echoed in error messages", async () => {
    const SENTINELS = {
      API_KEY: "SUPER_SECRET_API_KEY_12345",
      BODY: "RAW_UPSTREAM_BODY_SECRET",
      ERROR: "RAW_PROVIDER_ERROR_SECRET",
      STATUS: "RAW_STATUS_SECRET",
      PROMPT: "PROMPT_SECRET_IN_REQUEST",
    };

    // 1. Upstream HTTP 500 error body containing body and error sentinels
    const transport500 = createFakeTransport(async () => {
      return new Response(
        JSON.stringify({
          error: { message: SENTINELS.ERROR, code: "server_error" },
          leak: SENTINELS.BODY,
        }),
        { status: 500 }
      );
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const provider500 = new LiveAiProvider(config, SENTINELS.API_KEY, { transport: transport500 });
    const req = createSampleRequest({ prompt: SENTINELS.PROMPT });

    await assert.rejects(
      async () => provider500.complete(req),
      (err: any) => {
        const msg = err.message;
        assert.equal(msg.includes(SENTINELS.API_KEY), false);
        assert.equal(msg.includes(SENTINELS.BODY), false);
        assert.equal(msg.includes(SENTINELS.ERROR), false);
        assert.equal(msg.includes(SENTINELS.STATUS), false);
        assert.equal(msg.includes(SENTINELS.PROMPT), false);
        return true;
      }
    );

    // 2. Root error in HTTP 200 response
    const transportRootError = createFakeTransport(async () => {
      return createCustomResponse({
        object: "response",
        status: "completed",
        error: { message: SENTINELS.ERROR },
        output: [],
      });
    });
    const providerRootError = new LiveAiProvider(config, SENTINELS.API_KEY, { transport: transportRootError });
    await assert.rejects(
      async () => providerRootError.complete(req),
      (err: any) => {
        const msg = err.message;
        assert.equal(msg.includes(SENTINELS.ERROR), false);
        assert.equal(msg, "OpenAI provider response contained an error.");
        return true;
      }
    );

    // 3. Malicious non-standard HTTP status code (out of 100-599 range or non-numeric)
    const transportMaliciousStatus = createFakeTransport(async () => {
      return createCustomResponse("Malicious status response", 999);
    });
    const providerMaliciousStatus = new LiveAiProvider(config, SENTINELS.API_KEY, { transport: transportMaliciousStatus });
    await assert.rejects(
      async () => providerMaliciousStatus.complete(req),
      (err: any) => {
        const msg = err.message;
        assert.equal(msg.includes("999"), false);
        assert.equal(msg, "OpenAI provider request failed with unknown HTTP status.");
        return true;
      }
    );
  });
});

describe("Phase 5E: Cross-Gate Integration with Certified Domain Services", () => {
  it("Phase 5B (Catalog): successfully resolves unresolved category mapping via AI provider", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      const validSemanticJson = JSON.stringify({
        schemaVersion: 1,
        taskKind: "CATEGORY_MAPPING",
        selectedCandidateId: "c-1",
        confidence: 0.95,
        explanationSummary: "Product matches Electronics category directly.",
        evidenceRefs: ["e-1"],
      });
      return new Response(createMockResponseJson(validSemanticJson), { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const catalogService = new CatalogIntelligenceService({ semanticService });

    const result = await catalogService.mapCategory({
      productTitle: "Wireless Bluetooth Speaker",
      sourceCategoryPath: "Audio / Speakers",
      candidates: [
        { id: "c-1", name: "Speakers" },
        { id: "c-2", name: "Headphones" },
      ],
      evidence: [
        { id: "e-1", text: "Speaker in product title" },
      ],
    });

    assert.equal(transportCalls, 1);
    assert.equal(result.status, "SUGGESTED");
    assert.equal(result.reasonCode, "AI_SUGGESTION");
    assert.equal(result.resolutionSource, "AI");
    assert.equal(result.selectedCandidateId, "c-1");
    assert.equal(result.reviewRequired, true);
  });

  it("Phase 5B (Catalog): fails closed safely on provider failure", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      return new Response("Server error", { status: 500 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const catalogService = new CatalogIntelligenceService({ semanticService });

    const result = await catalogService.mapCategory({
      productTitle: "Unknown Brand Widget",
      sourceCategoryPath: "Tools / Hand Tools",
      candidates: [
        { id: "cat-1", name: "Tools" },
      ],
    });

    assert.equal(transportCalls, 1);
    assert.equal(result.status, "BLOCKED_FOR_REVIEW");
    assert.equal(result.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");
    assert.equal(result.selectedCandidateId, null);
    assert.equal(result.reviewRequired, true);
  });

  it("Phase 5C (Review): triggers semantic escalation with advisory findings and reviewRequired", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      const reviewOutput = JSON.stringify({
        schemaVersion: 1,
        taskKind: "ANOMALY_REVIEW",
        selectedCandidateId: null,
        confidence: 0.85,
        explanationSummary: "Suspicious price drop confirmed.",
        evidenceRefs: [],
      });
      return new Response(createMockResponseJson(reviewOutput), { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    // Provide context with suspectedAnomalyReasons to trigger semantic escalation
    const assessment = await reviewService.evaluateReview({
      productTitle: "Luxury Smartphone Flagship",
      selectedCategoryPath: "Electronics / Phones",
      suspectedAnomalyReasons: ["Price abnormally low compared to category baseline"],
    });

    assert.equal(transportCalls, 1);
    assert.equal(assessment.status, "NEEDS_REVIEW");
    assert.equal(assessment.reviewRequired, true);
    assert(assessment.advisorySummary?.includes("Suspicious price drop confirmed."));
    const aiAnnotation = assessment.findings.find((f) => f.code === "AI_ANOMALY_ANNOTATION");
    assert(aiAnnotation !== undefined);
  });

  it("Phase 5C (Review): fails closed safely on provider failure during eligible semantic review", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      return new Response("Internal Server Error", { status: 500 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const reviewService = new ReviewIntelligenceService({ semanticService });

    const assessment = await reviewService.evaluateReview({
      productTitle: "Luxury Smartphone Flagship",
      selectedCategoryPath: "Electronics / Phones",
      suspectedAnomalyReasons: ["Price abnormally low compared to category baseline"],
    });

    assert.equal(transportCalls, 1);
    assert.equal(assessment.status, "NEEDS_REVIEW");
    assert.equal(assessment.reviewRequired, true);
    assert.equal(assessment.advisorySummary, null);
    const hasAiAnnotation = assessment.findings.some((f) => f.code === "AI_ANOMALY_ANNOTATION");
    assert.equal(hasAiAnnotation, false);
  });

  it("Phase 5D (Parser Recovery): triggers structural recovery guidance via AI suggestion", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      const recoveryOutput = JSON.stringify({
        schemaVersion: 1,
        taskKind: "PARSER_RECOVERY_SUGGESTION",
        selectedCandidateId: null,
        confidence: 0.9,
        explanationSummary: "Price selector shifted to data-price-v2 attribute",
        evidenceRefs: ["e-1"],
      });
      return new Response(createMockResponseJson(recoveryOutput), { status: 200 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const parserRecoveryService = new ParserRecoveryService(semanticService);

    const recovery = await parserRecoveryService.evaluate({
      sourceUrlOrPath: "https://www.jakmall.com/product/item-1",
      failureCode: "MISSING_PRICE",
      observations: ["JSON_LD_PRODUCT_MISSING_OBSERVED"],
      evidence: [{ id: "e-1", text: "Price element selector missing in parsed DOM" }],
    });

    assert.equal(transportCalls, 1);
    assert.equal(recovery.status, "RECOVERY_GUIDANCE_AVAILABLE");
    assert.equal(recovery.reasonCode, "AI_RECOVERY_SUGGESTION");
    assert.equal(recovery.semanticSource, "AI");
    assert.equal(recovery.reviewRequired, true);
    assert(recovery.semanticSummary?.includes("Price selector shifted"));
  });

  it("Phase 5D (Parser Recovery): fails closed safely on provider failure", async () => {
    let transportCalls = 0;
    const transport = createFakeTransport(async () => {
      transportCalls++;
      return new Response("Server error", { status: 500 });
    });

    const config = resolveLiveProviderConfig({ mode: "LIVE" });
    const liveProvider = new LiveAiProvider(config, "valid-key", { transport });
    const semanticService = new SemanticIntelligenceService({ provider: liveProvider });
    const parserRecoveryService = new ParserRecoveryService(semanticService);

    const recovery = await parserRecoveryService.evaluate({
      sourceUrlOrPath: "https://www.jakmall.com/product/item-1",
      failureCode: "MISSING_PRICE",
      observations: ["JSON_LD_PRODUCT_MISSING_OBSERVED"],
      evidence: [{ id: "e-1", text: "Price element selector missing" }],
    });

    assert.equal(transportCalls, 1);
    assert.equal(recovery.status, "BLOCKED_FOR_REVIEW");
    assert.equal(recovery.reasonCode, "SEMANTIC_PROVIDER_UNAVAILABLE");
    assert.equal(recovery.reviewRequired, true);
  });
});
