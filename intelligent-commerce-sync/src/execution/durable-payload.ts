import { z } from "zod";
import {
  type CreateListingExecutionPayload,
  type DurableExecutionPayload,
  DurablePayloadValidationError,
  type UpdatePriceExecutionPayload,
  type UpdateStockExecutionPayload,
} from "./types.js";

const FORBIDDEN_SECURITY_KEYS = new Set<string>([
  "partnerkey",
  "partnerid",
  "accesstoken",
  "refreshtoken",
  "token",
  "credential",
  "credentials",
  "secret",
  "clientsecret",
  "privatekey",
  "password",
  "apikey",
  "authorization",
  "cookie",
  "session",
  "sessionid",
]);

/**
 * Recursively inspects a value to ensure it contains strictly valid JSON primitives:
 * - Rejects Date, undefined, functions, Symbols, BigInts, NaN, Infinity, -Infinity.
 * - Rejects Map, Set, RegExp, and class instances / non-standard prototypes.
 * - Rejects sparse arrays and objects with Symbol keys.
 * - Detects circular references using a recursion-stack WeakSet.
 * - Rejects forbidden security/credential keys.
 */
export function assertJsonSafety(
  value: unknown,
  path = "payload",
  activeStack = new WeakSet<object>()
): void {
  if (value === null) {
    return;
  }

  if (value === undefined) {
    throw new DurablePayloadValidationError(
      `Durable payload at '${path}' must not contain explicit undefined values.`
    );
  }

  if (typeof value === "boolean" || typeof value === "string") {
    return;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isNaN(value)) {
      throw new DurablePayloadValidationError(
        `Durable payload at '${path}' contains non-finite number: ${value}.`
      );
    }
    return;
  }

  if (typeof value === "function") {
    throw new DurablePayloadValidationError(
      `Durable payload at '${path}' must not contain function values.`
    );
  }

  if (typeof value === "symbol" || typeof value === "bigint") {
    throw new DurablePayloadValidationError(
      `Durable payload at '${path}' contains non-JSON primitive type: ${typeof value}.`
    );
  }

  if (value instanceof Date) {
    throw new DurablePayloadValidationError(
      `Durable payload at '${path}' must not contain Date instances; timestamps must be ISO strings.`
    );
  }

  if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new DurablePayloadValidationError(
      `Durable payload at '${path}' contains unsupported instance type: ${value.constructor.name}.`
    );
  }

  if (Array.isArray(value)) {
    if (activeStack.has(value)) {
      throw new DurablePayloadValidationError(`Circular reference detected at '${path}'.`);
    }
    activeStack.add(value);

    try {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          throw new DurablePayloadValidationError(
            `Sparse array hole detected at '${path}[${i}]'.`
          );
        }
        assertJsonSafety(value[i], `${path}[${i}]`, activeStack);
      }
    } finally {
      activeStack.delete(value);
    }
    return;
  }

  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new DurablePayloadValidationError(
        `Durable payload at '${path}' must be a plain object with Object or null prototype.`
      );
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new DurablePayloadValidationError(
        `Durable payload at '${path}' contains Symbol keys.`
      );
    }

    if (activeStack.has(value)) {
      throw new DurablePayloadValidationError(`Circular reference detected at '${path}'.`);
    }
    activeStack.add(value);

    try {
      for (const [k, v] of Object.entries(value)) {
        const lowerKey = k.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (FORBIDDEN_SECURITY_KEYS.has(lowerKey)) {
          throw new DurablePayloadValidationError(
            `Durable payload at '${path}.${k}' contains forbidden security/credential key.`
          );
        }
        assertJsonSafety(v, `${path}.${k}`, activeStack);
      }
    } finally {
      activeStack.delete(value);
    }
  }
}

/**
 * Checks that an array of items contains unique sourceSkuId values.
 */
function assertUniqueVariantSkus(
  variants: Array<{ sourceSkuId: string }>,
  opType: string
): void {
  const seen = new Set<string>();
  for (const variant of variants) {
    if (!variant.sourceSkuId || variant.sourceSkuId.trim().length === 0) {
      throw new DurablePayloadValidationError(
        `${opType} variant must have a non-empty sourceSkuId.`
      );
    }
    if (seen.has(variant.sourceSkuId)) {
      throw new DurablePayloadValidationError(
        `Duplicate sourceSkuId '${variant.sourceSkuId}' in ${opType} variants array.`
      );
    }
    seen.add(variant.sourceSkuId);
  }
}

const durableInventoryTargetSchema = z.discriminatedUnion("resolution", [
  z
    .object({
      resolution: z.literal("RESOLVED"),
      targetQuantity: z
        .number({ message: "targetQuantity must be a number" })
        .int("targetQuantity must be an integer")
        .nonnegative("targetQuantity must be non-negative (>= 0)"),
    })
    .strict(),
  z
    .object({
      resolution: z.literal("NEEDS_REVIEW"),
    })
    .strict(),
  z
    .object({
      resolution: z.literal("BLOCKED"),
    })
    .strict(),
]);

const basePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().trim().min(1, "source must not be empty"),
    sourceProductId: z.string().trim().min(1, "sourceProductId must not be empty"),
    sourceSnapshotId: z.string().trim().min(1, "sourceSnapshotId must not be empty"),
    marketplace: z.string().trim().min(1, "marketplace must not be empty"),
    sellerAccountKey: z.string().trim().min(1, "sellerAccountKey must not be empty"),
  })
  .strict();

const updatePriceVariantSchema = z
  .object({
    sourceSkuId: z.string().trim().min(1, "sourceSkuId must not be empty"),
    targetPriceIdr: z
      .number()
      .int("targetPriceIdr must be an integer")
      .positive("targetPriceIdr must be positive (> 0)"),
  })
  .strict();

const updateStockVariantSchema = z
  .object({
    sourceSkuId: z.string().trim().min(1, "sourceSkuId must not be empty"),
    inventory: durableInventoryTargetSchema,
  })
  .strict();

const createListingVariantSchema = z
  .object({
    sourceSkuId: z.string().trim().min(1, "sourceSkuId must not be empty"),
    destinationSku: z.string().trim().min(1, "destinationSku must not be empty"),
    attributes: z.record(z.string(), z.string()),
    targetPriceIdr: z
      .number()
      .int("targetPriceIdr must be an integer")
      .positive("targetPriceIdr must be positive (> 0)"),
    inventory: durableInventoryTargetSchema,
  })
  .strict();

const imageSchema = z
  .object({
    url: z.string().url("image url must be a valid URL"),
    position: z.number().int().nonnegative().optional(),
  })
  .strict();

const updatePricePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationType: z.literal("UPDATE_PRICE"),
    source: z.string().trim().min(1, "source must not be empty"),
    sourceProductId: z.string().trim().min(1, "sourceProductId must not be empty"),
    sourceSnapshotId: z.string().trim().min(1, "sourceSnapshotId must not be empty"),
    marketplace: z.string().trim().min(1, "marketplace must not be empty"),
    sellerAccountKey: z.string().trim().min(1, "sellerAccountKey must not be empty"),
    remoteListingId: z.string().trim().min(1).optional(),
    variants: z
      .array(updatePriceVariantSchema)
      .min(1, "UPDATE_PRICE payload must contain at least one variant"),
  })
  .strict();

const updateStockPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationType: z.literal("UPDATE_STOCK"),
    source: z.string().trim().min(1, "source must not be empty"),
    sourceProductId: z.string().trim().min(1, "sourceProductId must not be empty"),
    sourceSnapshotId: z.string().trim().min(1, "sourceSnapshotId must not be empty"),
    marketplace: z.string().trim().min(1, "marketplace must not be empty"),
    sellerAccountKey: z.string().trim().min(1, "sellerAccountKey must not be empty"),
    remoteListingId: z.string().trim().min(1).optional(),
    variants: z
      .array(updateStockVariantSchema)
      .min(1, "UPDATE_STOCK payload must contain at least one variant"),
  })
  .strict();

const createListingPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationType: z.literal("CREATE_LISTING"),
    source: z.string().trim().min(1, "source must not be empty"),
    sourceProductId: z.string().trim().min(1, "sourceProductId must not be empty"),
    sourceSnapshotId: z.string().trim().min(1, "sourceSnapshotId must not be empty"),
    marketplace: z.string().trim().min(1, "marketplace must not be empty"),
    sellerAccountKey: z.string().trim().min(1, "sellerAccountKey must not be empty"),
    preparedTitle: z.string().trim().min(1, "preparedTitle must not be empty"),
    preparedDescription: z.string(),
    targetCategoryId: z.string().trim().min(1).optional(),
    targetCategoryName: z.string().trim().min(1).optional(),
    brand: z.string().trim().optional(),
    totalWeightGrams: z.number().int().positive().optional(),
    images: z.array(imageSchema),
    variants: z
      .array(createListingVariantSchema)
      .min(1, "CREATE_LISTING payload must contain at least one variant"),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/**
 * Validates that an input object conforms to the DurableExecutionPayload contract.
 * Throws a DurablePayloadValidationError if a schema or business rule is violated.
 */
export function validateDurableExecutionPayload(
  payload: unknown
): DurableExecutionPayload {
  if (!payload || typeof payload !== "object") {
    throw new DurablePayloadValidationError("Payload must be a non-null object.");
  }

  // 1. Recursive JSON-safety check (Dates, functions, undefined, NaN, circular references, security tokens)
  assertJsonSafety(payload);

  const raw = payload as Record<string, unknown>;
  const opType = raw["operationType"];

  if (opType !== "CREATE_LISTING" && opType !== "UPDATE_PRICE" && opType !== "UPDATE_STOCK") {
    throw new DurablePayloadValidationError(
      `Invalid or unsupported operationType in payload: '${String(opType)}'.`
    );
  }

  try {
    if (opType === "UPDATE_PRICE") {
      const parsed = updatePricePayloadSchema.parse(payload) as UpdatePriceExecutionPayload;
      assertUniqueVariantSkus(parsed.variants, "UPDATE_PRICE");
      return parsed;
    }

    if (opType === "UPDATE_STOCK") {
      const parsed = updateStockPayloadSchema.parse(payload) as UpdateStockExecutionPayload;
      assertUniqueVariantSkus(parsed.variants, "UPDATE_STOCK");
      return parsed;
    }

    // CREATE_LISTING
    const parsed = createListingPayloadSchema.parse(payload) as CreateListingExecutionPayload;
    assertUniqueVariantSkus(parsed.variants, "CREATE_LISTING");
    return parsed;
  } catch (err) {
    if (err instanceof DurablePayloadValidationError) {
      throw err;
    }
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new DurablePayloadValidationError(`Validation failed for ${opType} payload: ${issues}`);
    }
    throw new DurablePayloadValidationError(
      `Unexpected error validating ${opType} payload: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
