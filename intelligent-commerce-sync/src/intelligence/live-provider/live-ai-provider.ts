/**
 * Phase 5E: Controlled Live Semantic AI Provider Implementation
 * Fixed OpenAI Responses API Transport, Health Gates, and Safety Envelopes.
 */

import {
  SemanticConfigurationError,
  SemanticProviderError,
  type SemanticAiProvider,
  type SemanticProviderRequest,
  type SemanticProviderResponse,
} from "../types.js";
import {
  resolveLiveProviderConfig,
  resolveLiveProviderConfigFromEnv,
} from "./config.js";
import {
  validateRequestEnvelope,
  validatePrivacyGate,
} from "./privacy-gate.js";
import {
  ProviderControls,
  SystemClock,
} from "./provider-controls.js";
import type {
  Clock,
  LiveProviderConfig,
  LiveProviderDependencies,
  LiveProviderFetch,
  LiveProviderUsageSnapshot,
} from "./types.js";

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isStrictPlainObject(val: unknown): val is Record<string, unknown> {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    return false;
  }
  const proto = Object.getPrototypeOf(val);
  if (proto !== Object.prototype && proto !== null) {
    if (proto && typeof proto === "object" && proto.constructor === Object) {
      // Allow custom plain object prototypes for controlled inheritance tests
    } else {
      return false;
    }
  }
  if (Object.getOwnPropertySymbols(val).length > 0) {
    return false;
  }
  return true;
}

function isDenseArray(arr: unknown): arr is unknown[] {
  if (!Array.isArray(arr)) {
    return false;
  }
  for (let i = 0; i < arr.length; i++) {
    if (!hasOwn(arr, i)) {
      return false;
    }
  }
  return true;
}

export class LiveAiProvider implements SemanticAiProvider {
  readonly #apiKey: string | null;
  private readonly config: LiveProviderConfig;
  private readonly transport: LiveProviderFetch;
  private readonly clock: Clock;
  private readonly controls: ProviderControls;
  private processDispatchCount = 0;

  constructor(
    config: LiveProviderConfig,
    apiKey: string | null,
    dependencies?: LiveProviderDependencies
  ) {
    this.config = resolveLiveProviderConfig(config);
    if (this.config.mode === "LIVE") {
      if (apiKey === null || apiKey === undefined || typeof apiKey !== "string" || apiKey.trim().length === 0) {
        throw new SemanticConfigurationError(
          "OPENAI_API_KEY is required and must not be blank in LIVE mode."
        );
      }
      this.#apiKey = apiKey.trim();
    } else {
      this.#apiKey = null;
    }
    this.clock = dependencies?.clock ?? new SystemClock();
    this.transport = dependencies?.transport ?? globalThis.fetch;
    this.controls = new ProviderControls(this.clock);
  }

  getConfig(): LiveProviderConfig {
    return this.config;
  }

  getUsageSnapshot(): LiveProviderUsageSnapshot {
    return this.controls.getUsageSnapshot();
  }

  async complete(request: SemanticProviderRequest): Promise<SemanticProviderResponse> {
    this.controls.usageLedger.incrementCompleteCalls();

    // Mode check: DISABLED short-circuits immediately without any envelope or privacy processing
    if (this.config.mode === "DISABLED") {
      throw new SemanticProviderError("Semantic AI provider is DISABLED.");
    }

    // 1. Validate request envelope (defense-in-depth)
    validateRequestEnvelope(request);

    // 2. Privacy Gate & Allowlist Consistency
    validatePrivacyGate(request);

    // 3. Request Text Budget Validation (character count)
    const totalTextChars = request.systemInstruction.length + request.prompt.length;
    if (totalTextChars > this.config.maxRequestTextChars) {
      this.controls.usageLedger.incrementBudgetBlocked();
      throw new SemanticProviderError(
        `Semantic AI provider request text exceeds budget: ${totalTextChars} > ${this.config.maxRequestTextChars}.`
      );
    }

    // Mode Routing: DRY_RUN
    if (this.config.mode === "DRY_RUN") {
      this.controls.usageLedger.incrementDryRunChecks();
      throw new SemanticProviderError(
        "Semantic AI provider is in DRY_RUN mode; network dispatch simulated safely."
      );
    }

    // LIVE mode gates
    // Process budget check
    if (this.processDispatchCount >= this.config.maxRequestsPerProcess) {
      this.controls.usageLedger.incrementBudgetBlocked();
      throw new SemanticProviderError("Semantic AI provider process request budget exceeded.");
    }

    // Pre-dispatch abort check (zero live control or dispatch reservation made)
    if (request.signal.aborted) {
      throw new SemanticProviderError("OpenAI provider request was aborted before dispatch.");
    }

    // Circuit breaker admission check
    const circuitCheck = this.controls.circuitBreaker.canAttempt(this.config.cooldownMs);
    if (!circuitCheck.allowed) {
      this.controls.usageLedger.incrementCircuitBlocked();
      throw new SemanticProviderError("Semantic AI provider circuit is OPEN.");
    }

    // Rate limiter reservation check
    const rateAllowed = this.controls.rateLimiter.checkAndReserve(
      this.config.windowMs,
      this.config.maxRequestsPerWindow
    );
    if (!rateAllowed) {
      if (circuitCheck.isProbe) {
        this.controls.circuitBreaker.clearProbeFlag();
      }
      this.controls.usageLedger.incrementRateLimitBlocked();
      throw new SemanticProviderError("OpenAI provider rate limit exceeded.");
    }

    // Reserve process dispatch slot and record network dispatch attempt
    this.processDispatchCount++;
    this.controls.usageLedger.incrementNetworkDispatches();

    // Construct Responses request payload
    const payload = {
      model: "gpt-5.6-luna",
      instructions: request.systemInstruction,
      input: request.prompt,
      store: false,
      max_output_tokens: this.config.maxOutputTokens,
      truncation: "disabled",
      reasoning: {
        effort: "none",
      },
      text: {
        format: {
          type: "json_schema",
          name: "semantic_intelligence_response",
          strict: true,
          schema: {
            type: "object",
            properties: {
              schemaVersion: {
                type: "integer",
                enum: [1],
              },
              taskKind: {
                type: "string",
                enum: [request.taskKind],
              },
              selectedCandidateId: {
                type: ["string", "null"],
              },
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1,
              },
              explanationSummary: {
                type: "string",
              },
              evidenceRefs: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: [
              "schemaVersion",
              "taskKind",
              "selectedCandidateId",
              "confidence",
              "explanationSummary",
              "evidenceRefs",
            ],
            additionalProperties: false,
          },
        },
      },
    };

    let response: Response;
    try {
      response = await this.transport(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: request.signal,
        redirect: "error",
      });
    } catch (fetchErr: unknown) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.recordHealthFailure(this.config.failureThreshold);
      if (request.signal.aborted) {
        throw new SemanticProviderError("OpenAI provider request was aborted.");
      }
      throw new SemanticProviderError("OpenAI provider network transport failed.");
    }

    const statusNum =
      typeof response.status === "number" &&
      Number.isInteger(response.status) &&
      response.status >= 100 &&
      response.status <= 599
        ? response.status
        : null;

    // Upstream health-impacting HTTP errors (429 and 5xx)
    if (response.status === 429 || (statusNum !== null && statusNum >= 500)) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.recordHealthFailure(this.config.failureThreshold);
      const statusMsg = statusNum !== null ? `HTTP ${statusNum}` : "unknown HTTP status";
      throw new SemanticProviderError(
        `OpenAI provider request failed with ${statusMsg}.`
      );
    }

    // Other HTTP 4xx errors (client/auth errors do not trip circuit)
    if (statusNum !== null && statusNum >= 400 && statusNum < 500) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError(
        `OpenAI provider request failed with HTTP ${statusNum}.`
      );
    }

    if (!response.ok) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      const statusMsg = statusNum !== null ? `HTTP ${statusNum}` : "unknown HTTP status";
      throw new SemanticProviderError(
        `OpenAI provider request failed with ${statusMsg}.`
      );
    }

    let rawJson: unknown;
    try {
      rawJson = await response.json();
    } catch {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response was malformed.");
    }

    if (!isStrictPlainObject(rawJson)) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response was malformed.");
    }

    const root = rawJson;

    // Responses envelope validation: root must have OWN required fields: object, status.
    if (
      !hasOwn(root, "object") ||
      root.object !== "response" ||
      !hasOwn(root, "status")
    ) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response was malformed.");
    }

    // Authoritative usage validation & accounting:
    // Evaluated independently of subsequent status failures or semantic output acceptance
    if (hasOwn(root, "usage") && root.usage !== undefined && root.usage !== null) {
      if (!isStrictPlainObject(root.usage)) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider usage response was malformed.");
      }
      const u = root.usage;
      if (
        !hasOwn(u, "input_tokens") ||
        !hasOwn(u, "output_tokens") ||
        !hasOwn(u, "total_tokens") ||
        typeof u.input_tokens !== "number" ||
        typeof u.output_tokens !== "number" ||
        typeof u.total_tokens !== "number" ||
        !Number.isFinite(u.input_tokens) ||
        !Number.isInteger(u.input_tokens) ||
        u.input_tokens < 0 ||
        !Number.isFinite(u.output_tokens) ||
        !Number.isInteger(u.output_tokens) ||
        u.output_tokens < 0 ||
        !Number.isFinite(u.total_tokens) ||
        !Number.isInteger(u.total_tokens) ||
        u.total_tokens < 0
      ) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider usage response was malformed.");
      }

      this.controls.usageLedger.recordUsage(u.input_tokens, u.output_tokens, u.total_tokens);
    } else {
      this.controls.usageLedger.recordMissingUsage();
    }

    // Responses error evaluation: fails closed after authoritative usage accounting
    // without leaking raw error payload or provider error fields.
    if (hasOwn(root, "error") && root.error != null) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response contained an error.");
    }

    // Responses status evaluation
    if (root.status === "incomplete") {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      if (hasOwn(root, "incomplete_details")) {
        const incDetails = root.incomplete_details;
        if (
          isStrictPlainObject(incDetails) &&
          hasOwn(incDetails, "reason") &&
          incDetails.reason === "max_output_tokens"
        ) {
          throw new SemanticProviderError(
            "OpenAI provider response incomplete: max_output_tokens exceeded."
          );
        }
      }
      throw new SemanticProviderError("OpenAI provider response was incomplete.");
    }

    if (root.status !== "completed") {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response was not completed.");
    }

    // One exact output extraction algorithm
    if (!hasOwn(root, "output")) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }
    const outputArr = root.output;
    if (!isDenseArray(outputArr)) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    let assistantMessageItem: Record<string, unknown> | null = null;
    for (const item of outputArr) {
      if (!isStrictPlainObject(item)) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider response output was invalid.");
      }
      if (!hasOwn(item, "type")) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider response output was invalid.");
      }
      if (item.type === "reasoning") {
        continue;
      }
      if (item.type === "message") {
        if (
          !hasOwn(item, "role") ||
          !hasOwn(item, "status") ||
          !hasOwn(item, "content") ||
          item.role !== "assistant" ||
          item.status !== "completed"
        ) {
          this.controls.usageLedger.incrementFailedNetworkResponses();
          this.controls.circuitBreaker.clearProbeFlag();
          throw new SemanticProviderError("OpenAI provider response output was invalid.");
        }
        if (assistantMessageItem !== null) {
          this.controls.usageLedger.incrementFailedNetworkResponses();
          this.controls.circuitBreaker.clearProbeFlag();
          throw new SemanticProviderError("OpenAI provider response output was invalid.");
        }
        assistantMessageItem = item;
        continue;
      }

      // Any unexpected output item type (tools, searches, etc.)
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    if (!assistantMessageItem) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    const contentArr = assistantMessageItem.content;
    if (!isDenseArray(contentArr)) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    let extractedText: string | null = null;
    for (const c of contentArr) {
      if (!isStrictPlainObject(c)) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider response output was invalid.");
      }
      if (!hasOwn(c, "type")) {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider response output was invalid.");
      }
      if (c.type === "refusal") {
        this.controls.usageLedger.incrementFailedNetworkResponses();
        this.controls.circuitBreaker.clearProbeFlag();
        throw new SemanticProviderError("OpenAI provider response output was invalid.");
      }
      if (c.type === "output_text") {
        if (!hasOwn(c, "text")) {
          this.controls.usageLedger.incrementFailedNetworkResponses();
          this.controls.circuitBreaker.clearProbeFlag();
          throw new SemanticProviderError("OpenAI provider response output was invalid.");
        }
        if (extractedText !== null) {
          this.controls.usageLedger.incrementFailedNetworkResponses();
          this.controls.circuitBreaker.clearProbeFlag();
          throw new SemanticProviderError("OpenAI provider response output was invalid.");
        }
        if (typeof c.text !== "string" || c.text.trim().length === 0) {
          this.controls.usageLedger.incrementFailedNetworkResponses();
          this.controls.circuitBreaker.clearProbeFlag();
          throw new SemanticProviderError("OpenAI provider response output was invalid.");
        }
        extractedText = c.text;
        continue;
      }

      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    if (extractedText === null) {
      this.controls.usageLedger.incrementFailedNetworkResponses();
      this.controls.circuitBreaker.clearProbeFlag();
      throw new SemanticProviderError("OpenAI provider response output was invalid.");
    }

    // Successful completion: update circuit and usage ledger
    this.controls.circuitBreaker.recordSuccess();
    this.controls.usageLedger.incrementSuccessfulNetworkResponses();

    return {
      rawText: extractedText,
    };
  }
}

export function createLiveAiProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  dependencies?: LiveProviderDependencies
): LiveAiProvider {
  const config = resolveLiveProviderConfigFromEnv(env);
  let apiKey: string | null = null;
  if (config.mode === "LIVE") {
    const rawKey = env.OPENAI_API_KEY?.trim() ?? "";
    apiKey = rawKey.length > 0 ? rawKey : null;
  }
  return new LiveAiProvider(config, apiKey, dependencies);
}
