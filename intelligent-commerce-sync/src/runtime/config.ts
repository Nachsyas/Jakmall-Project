import { RuntimeConfigurationError, type RuntimeConfig } from "./types.js";

export const DEFAULT_STALE_PROCESSING_MS = 300000; // 5 minutes
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 30000; // 30 seconds
export const DEFAULT_BATCH_SIZE = 50;

export const MIN_STALE_PROCESSING_MS = 60000; // 1 minute minimum
export const MIN_MAINTENANCE_INTERVAL_MS = 1000; // 1 second minimum
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 500;

function parseInteger(
  name: string,
  raw: string | number | undefined,
  defaultValue: number,
  min: number,
  max?: number
): number {
  if (raw === undefined) {
    return defaultValue;
  }

  if (typeof raw === "string" && raw.trim().length === 0) {
    throw new RuntimeConfigurationError(
      `Configuration property '${name}' cannot be empty or whitespace-only.`
    );
  }

  let value: number;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || Number.isNaN(raw)) {
      throw new RuntimeConfigurationError(
        `Configuration property '${name}' must be an integer. Received: ${raw}.`
      );
    }
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^-?\d+$/.test(trimmed)) {
      throw new RuntimeConfigurationError(
        `Configuration property '${name}' must be an integer string. Received: '${trimmed}'.`
      );
    }
    value = parseInt(trimmed, 10);
    if (!Number.isSafeInteger(value)) {
      throw new RuntimeConfigurationError(
        `Configuration property '${name}' exceeds safe integer limits. Received: '${trimmed}'.`
      );
    }
  } else {
    throw new RuntimeConfigurationError(
      `Configuration property '${name}' must be a number or numeric string.`
    );
  }

  if (value < min) {
    throw new RuntimeConfigurationError(
      `Configuration property '${name}' cannot be less than ${min}. Received: ${value}.`
    );
  }

  if (max !== undefined && value > max) {
    throw new RuntimeConfigurationError(
      `Configuration property '${name}' cannot exceed ${max}. Received: ${value}.`
    );
  }

  return value;
}

export function parseRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const staleProcessingMs = parseInteger(
    "SYNC_RUNTIME_STALE_PROCESSING_MS",
    env.SYNC_RUNTIME_STALE_PROCESSING_MS,
    DEFAULT_STALE_PROCESSING_MS,
    MIN_STALE_PROCESSING_MS
  );

  const maintenanceIntervalMs = parseInteger(
    "SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS",
    env.SYNC_RUNTIME_MAINTENANCE_INTERVAL_MS,
    DEFAULT_MAINTENANCE_INTERVAL_MS,
    MIN_MAINTENANCE_INTERVAL_MS
  );

  const batchSize = parseInteger(
    "SYNC_RUNTIME_BATCH_SIZE",
    env.SYNC_RUNTIME_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE
  );

  return {
    staleProcessingMs,
    maintenanceIntervalMs,
    batchSize,
  };
}

export function resolveRuntimeConfig(
  overrides?: Partial<RuntimeConfig>,
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const base = parseRuntimeConfig(env);

  if (!overrides) {
    return base;
  }

  const staleProcessingMs = parseInteger(
    "staleProcessingMs",
    overrides.staleProcessingMs,
    base.staleProcessingMs,
    MIN_STALE_PROCESSING_MS
  );

  const maintenanceIntervalMs = parseInteger(
    "maintenanceIntervalMs",
    overrides.maintenanceIntervalMs,
    base.maintenanceIntervalMs,
    MIN_MAINTENANCE_INTERVAL_MS
  );

  const batchSize = parseInteger(
    "batchSize",
    overrides.batchSize,
    base.batchSize,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE
  );

  return {
    staleProcessingMs,
    maintenanceIntervalMs,
    batchSize,
  };
}

export function validateRuntimeConfig(config: unknown): RuntimeConfig {
  if (typeof config !== "object" || config === null) {
    throw new RuntimeConfigurationError("RuntimeConfig must be a non-null object.");
  }
  const c = config as Record<string, unknown>;
  const staleProcessingMs = parseInteger(
    "staleProcessingMs",
    c.staleProcessingMs as number | string | undefined,
    DEFAULT_STALE_PROCESSING_MS,
    MIN_STALE_PROCESSING_MS
  );
  const maintenanceIntervalMs = parseInteger(
    "maintenanceIntervalMs",
    c.maintenanceIntervalMs as number | string | undefined,
    DEFAULT_MAINTENANCE_INTERVAL_MS,
    MIN_MAINTENANCE_INTERVAL_MS
  );
  const batchSize = parseInteger(
    "batchSize",
    c.batchSize as number | string | undefined,
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE
  );
  return {
    staleProcessingMs,
    maintenanceIntervalMs,
    batchSize,
  };
}

export function validateBatchSize(
  batchSize: number | undefined,
  defaultBatchSize: number
): number {
  if (batchSize === undefined) {
    return defaultBatchSize;
  }
  return parseInteger("batchSize", batchSize, defaultBatchSize, MIN_BATCH_SIZE, MAX_BATCH_SIZE);
}
