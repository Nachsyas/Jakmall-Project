/**
 * Phase 5B: Deterministic String Normalization
 * Pure, locale-independent string normalization for verified mapping lookup keys.
 */

import { CATALOG_BOUNDS, CatalogInputValidationError } from "./types.js";

/**
 * Normalizes a raw catalog lookup key deterministically:
 * 1. Validates string type and non-blank constraint.
 * 2. Enforces maximum character bounds before normalization.
 * 3. Applies Unicode NFKC normalization.
 * 4. Lowercases using standard locale-independent toLowerCase().
 * 5. Trims leading and trailing whitespace.
 * 6. Collapses internal contiguous whitespace to a single space.
 * 7. Revalidates non-blank and maximum character bounds after normalization.
 */
export function normalizeLookupKey(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new CatalogInputValidationError("Lookup key must be a string.");
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new CatalogInputValidationError("Lookup key cannot be blank or whitespace-only.");
  }

  if (raw.length > CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH) {
    throw new CatalogInputValidationError(
      `Lookup key length (${raw.length}) exceeds maximum limit (${CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH}).`
    );
  }

  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

  if (normalized.length === 0) {
    throw new CatalogInputValidationError("Normalized lookup key cannot be empty.");
  }

  if (normalized.length > CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH) {
    throw new CatalogInputValidationError(
      `Normalized lookup key length (${normalized.length}) exceeds maximum limit (${CATALOG_BOUNDS.MAX_SOURCE_KEY_LENGTH}).`
    );
  }

  return normalized;
}
