/**
 * Phase 5E: Live Provider Configuration & Environment Boundary
 * Strict runtime parsing, finite bounding, and secret isolation.
 */

import { SemanticConfigurationError } from "../types.js";
import type { LiveProviderConfig, LiveProviderMode } from "./types.js";

export const DEFAULT_LIVE_PROVIDER_CONFIG: LiveProviderConfig = Object.freeze({
  mode: "DISABLED" as const,
  provider: "OPENAI" as const,
  model: "gpt-5.6-luna" as const,
  maxOutputTokens: 800,
  maxRequestTextChars: 16000,
  maxRequestsPerWindow: 60,
  windowMs: 60000,
  maxRequestsPerProcess: 1000,
  failureThreshold: 5,
  cooldownMs: 30000,
});

export const CONFIG_BOUNDS = {
  maxOutputTokens: { min: 50, max: 4000 },
  maxRequestTextChars: { min: 500, max: 50000 },
  maxRequestsPerWindow: { min: 1, max: 1000 },
  windowMs: { min: 1000, max: 600000 },
  maxRequestsPerProcess: { min: 1, max: 100000 },
  failureThreshold: { min: 1, max: 20 },
  cooldownMs: { min: 1000, max: 300000 },
} as const;

const ALLOWED_CONFIG_KEYS = new Set([
  "mode",
  "provider",
  "model",
  "maxOutputTokens",
  "maxRequestTextChars",
  "maxRequestsPerWindow",
  "windowMs",
  "maxRequestsPerProcess",
  "failureThreshold",
  "cooldownMs",
]);

function validateBoundedInteger(
  name: keyof typeof CONFIG_BOUNDS,
  val: unknown,
  fallback: number
): number {
  if (val === undefined || val === null) {
    return fallback;
  }
  if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val)) {
    throw new SemanticConfigurationError(
      `Live provider config '${name}' must be a finite integer, received: ${String(val)}.`
    );
  }
  const { min, max } = CONFIG_BOUNDS[name];
  if (val < min || val > max) {
    throw new SemanticConfigurationError(
      `Live provider config '${name}' must be between ${min} and ${max}, received: ${val}.`
    );
  }
  return val;
}

export function deepFreeze<T>(val: T): T {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      deepFreeze(item);
    }
  } else {
    for (const key of Object.keys(val)) {
      deepFreeze((val as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(val);
}

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function resolveLiveProviderConfig(
  raw?: unknown
): LiveProviderConfig {
  if (raw === undefined) {
    return deepFreeze({ ...DEFAULT_LIVE_PROVIDER_CONFIG });
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SemanticConfigurationError("Live provider config must be a non-null plain object.");
  }

  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    if (proto && typeof proto === "object" && proto.constructor === Object) {
      // Allow custom plain object prototypes for controlled inheritance tests
    } else {
      throw new SemanticConfigurationError("Live provider config must be a plain object.");
    }
  }

  if (Object.getOwnPropertySymbols(raw).length > 0) {
    throw new SemanticConfigurationError("Live provider config must not contain symbol-keyed properties.");
  }

  for (const k of Object.keys(raw)) {
    if (!ALLOWED_CONFIG_KEYS.has(k)) {
      throw new SemanticConfigurationError(`Unknown property '${k}' in live provider config.`);
    }
  }

  const rawObj = raw as Record<string, unknown>;

  // Validate mode (own-property only)
  const mode: LiveProviderMode = hasOwn(rawObj, "mode")
    ? (rawObj.mode as LiveProviderMode)
    : DEFAULT_LIVE_PROVIDER_CONFIG.mode;
  if (mode !== "DISABLED" && mode !== "DRY_RUN" && mode !== "LIVE") {
    throw new SemanticConfigurationError(
      `Invalid live provider mode '${String(mode)}'. Allowed modes: DISABLED, DRY_RUN, LIVE.`
    );
  }

  // Validate provider (own-property only)
  const provider = hasOwn(rawObj, "provider")
    ? (rawObj.provider as string)
    : DEFAULT_LIVE_PROVIDER_CONFIG.provider;
  if (provider !== "OPENAI") {
    throw new SemanticConfigurationError(
      `Invalid live provider '${String(provider)}'. Exactly 'OPENAI' is supported.`
    );
  }

  // Validate model (own-property only)
  const model = hasOwn(rawObj, "model")
    ? (rawObj.model as string)
    : DEFAULT_LIVE_PROVIDER_CONFIG.model;
  if (model !== "gpt-5.6-luna") {
    throw new SemanticConfigurationError(
      `Invalid live model '${String(model)}'. Exactly 'gpt-5.6-luna' is supported.`
    );
  }

  const resolved: LiveProviderConfig = {
    mode,
    provider: "OPENAI",
    model: "gpt-5.6-luna",
    maxOutputTokens: hasOwn(rawObj, "maxOutputTokens")
      ? validateBoundedInteger(
          "maxOutputTokens",
          rawObj.maxOutputTokens,
          DEFAULT_LIVE_PROVIDER_CONFIG.maxOutputTokens
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.maxOutputTokens,
    maxRequestTextChars: hasOwn(rawObj, "maxRequestTextChars")
      ? validateBoundedInteger(
          "maxRequestTextChars",
          rawObj.maxRequestTextChars,
          DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestTextChars
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestTextChars,
    maxRequestsPerWindow: hasOwn(rawObj, "maxRequestsPerWindow")
      ? validateBoundedInteger(
          "maxRequestsPerWindow",
          rawObj.maxRequestsPerWindow,
          DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestsPerWindow
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestsPerWindow,
    windowMs: hasOwn(rawObj, "windowMs")
      ? validateBoundedInteger(
          "windowMs",
          rawObj.windowMs,
          DEFAULT_LIVE_PROVIDER_CONFIG.windowMs
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.windowMs,
    maxRequestsPerProcess: hasOwn(rawObj, "maxRequestsPerProcess")
      ? validateBoundedInteger(
          "maxRequestsPerProcess",
          rawObj.maxRequestsPerProcess,
          DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestsPerProcess
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.maxRequestsPerProcess,
    failureThreshold: hasOwn(rawObj, "failureThreshold")
      ? validateBoundedInteger(
          "failureThreshold",
          rawObj.failureThreshold,
          DEFAULT_LIVE_PROVIDER_CONFIG.failureThreshold
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.failureThreshold,
    cooldownMs: hasOwn(rawObj, "cooldownMs")
      ? validateBoundedInteger(
          "cooldownMs",
          rawObj.cooldownMs,
          DEFAULT_LIVE_PROVIDER_CONFIG.cooldownMs
        )
      : DEFAULT_LIVE_PROVIDER_CONFIG.cooldownMs,
  };

  return deepFreeze(resolved);
}

function parseEnvInt(val: string | undefined): number | undefined {
  if (val === undefined || val.trim() === "") {
    return undefined;
  }
  const parsed = Number(val.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new SemanticConfigurationError(
      `Environment variable expected integer, received: '${val}'.`
    );
  }
  return parsed;
}

export function resolveLiveProviderConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): LiveProviderConfig {
  const modeRaw = env.AI_PROVIDER_MODE?.trim() || "DISABLED";
  if (modeRaw !== "DISABLED" && modeRaw !== "DRY_RUN" && modeRaw !== "LIVE") {
    throw new SemanticConfigurationError(
      `Invalid AI_PROVIDER_MODE environment variable: '${modeRaw}'.`
    );
  }
  const mode = modeRaw as LiveProviderMode;

  const modelRaw = env.AI_PROVIDER_MODEL?.trim() || "gpt-5.6-luna";
  if (modelRaw !== "gpt-5.6-luna") {
    throw new SemanticConfigurationError(
      `Invalid AI_PROVIDER_MODEL environment variable: '${modelRaw}'. Exactly 'gpt-5.6-luna' is supported.`
    );
  }

  const partialConfig: Record<string, unknown> = {
    mode,
    provider: "OPENAI",
    model: "gpt-5.6-luna",
  };

  const maxOutputTokens = parseEnvInt(env.AI_PROVIDER_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens !== undefined) partialConfig.maxOutputTokens = maxOutputTokens;

  const maxRequestTextChars = parseEnvInt(env.AI_PROVIDER_MAX_REQUEST_TEXT_CHARS);
  if (maxRequestTextChars !== undefined) partialConfig.maxRequestTextChars = maxRequestTextChars;

  const maxRequestsPerWindow = parseEnvInt(env.AI_PROVIDER_MAX_REQUESTS_PER_WINDOW);
  if (maxRequestsPerWindow !== undefined) partialConfig.maxRequestsPerWindow = maxRequestsPerWindow;

  const windowMs = parseEnvInt(env.AI_PROVIDER_WINDOW_MS);
  if (windowMs !== undefined) partialConfig.windowMs = windowMs;

  const maxRequestsPerProcess = parseEnvInt(env.AI_PROVIDER_MAX_REQUESTS_PER_PROCESS);
  if (maxRequestsPerProcess !== undefined) partialConfig.maxRequestsPerProcess = maxRequestsPerProcess;

  const failureThreshold = parseEnvInt(env.AI_PROVIDER_FAILURE_THRESHOLD);
  if (failureThreshold !== undefined) partialConfig.failureThreshold = failureThreshold;

  const cooldownMs = parseEnvInt(env.AI_PROVIDER_COOLDOWN_MS);
  if (cooldownMs !== undefined) partialConfig.cooldownMs = cooldownMs;

  return resolveLiveProviderConfig(partialConfig);
}
