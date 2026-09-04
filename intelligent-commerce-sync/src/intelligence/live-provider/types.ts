/**
 * Phase 5E: Controlled Live Semantic AI Provider Types
 * Fixed OpenAI Responses API Contracts & Public Safe Configurations
 */

export interface Clock {
  nowMs(): number;
}

export type LiveProviderMode = "DISABLED" | "DRY_RUN" | "LIVE";

export interface LiveProviderConfig {
  readonly mode: LiveProviderMode;
  readonly provider: "OPENAI";
  readonly model: "gpt-5.6-luna";
  readonly maxOutputTokens: number;
  readonly maxRequestTextChars: number;
  readonly maxRequestsPerWindow: number;
  readonly windowMs: number;
  readonly maxRequestsPerProcess: number;
  readonly failureThreshold: number;
  readonly cooldownMs: number;
}

export interface LiveProviderUsageSnapshot {
  readonly completeCalls: number;
  readonly dryRunChecks: number;
  readonly networkDispatches: number;
  readonly successfulNetworkResponses: number;
  readonly failedNetworkResponses: number;
  readonly rateLimitBlocked: number;
  readonly budgetBlocked: number;
  readonly circuitBlocked: number;
  readonly usageReportedRequests: number;
  readonly usageMissingRequests: number;
  readonly reportedInputTokens: number;
  readonly reportedOutputTokens: number;
  readonly reportedTotalTokens: number;
}

export type LiveProviderFetch = (
  url: string,
  init: RequestInit
) => Promise<Response>;

export interface LiveProviderDependencies {
  readonly transport?: LiveProviderFetch | undefined;
  readonly clock?: Clock | undefined;
}

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
