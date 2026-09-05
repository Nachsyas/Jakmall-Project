import type {
  CanonicalProduct,
  CanonicalVariant,
  CanonicalImage,
} from "../canonical/types.js";
import type {
  ParsedJakmallPage,
  JakmallRawSkuItem,
} from "./types.js";

export class JakmallNormalizerError extends Error {
  constructor(
    message: string,
    public readonly code: string = "NORMALIZATION_FAILED"
  ) {
    super(message);
    this.name = "JakmallNormalizerError";
  }
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

/**
 * Resolves attribute combinations for each SKU using spdt.variants and spdt.matrix.
 * Supports arbitrary dimension counts, generic nested trees, flat compound keys,
 * and tracks `previous` dimension ordering where present in source data.
 */
export function resolveVariantAttributes(
  variantsDef?: Record<string, unknown> | Record<string, unknown>[] | null,
  matrixDef?: Record<string, unknown> | null
): Map<string, Record<string, string>> {
  const skuAttributes = new Map<string, Record<string, string>>();

  if (!matrixDef || typeof matrixDef !== "object") {
    return skuAttributes;
  }

  // 1. Build dimension lookup and track previous ordering if available
  const hashLookup = new Map<string, { dimension: string; value: string }>();

  if (variantsDef && typeof variantsDef === "object") {
    const rawDims = Array.isArray(variantsDef)
      ? variantsDef
      : Object.entries(variantsDef).map(([key, val]) => ({ key, val }));

    for (const entry of rawDims) {
      let dimName = "key" in entry && typeof entry.key === "string" ? entry.key : "";
      const dimData = "val" in entry ? entry.val : entry;

      let optionsObj: Record<string, unknown> = {};

      if (isRecord(dimData)) {
        if (typeof dimData.name === "string") {
          dimName = dimData.name;
        }
        if (isRecord(dimData.options)) {
          optionsObj = dimData.options;
        } else if (isRecord(dimData.items)) {
          optionsObj = dimData.items;
        } else if (isRecord(dimData.values)) {
          optionsObj = dimData.values;
        } else {
          optionsObj = dimData;
        }
      }

      for (const [valHash, valItem] of Object.entries(optionsObj)) {
        // Skip metadata keys if present
        if (["previous", "name", "id", "label"].includes(valHash) && typeof valItem === "string" && !hashLookup.has(valHash)) {
          continue;
        }
        let valString = "";
        if (typeof valItem === "string") {
          valString = valItem;
        } else if (isRecord(valItem)) {
          const rawVal = valItem.name ?? valItem.title ?? valItem.value ?? "";
          valString = String(rawVal);
        }
        if (valString) {
          hashLookup.set(String(valHash), { dimension: dimName, value: valString });
        }
      }
    }
  }

  // 2. Helper to assign attributes to a resolved leaf SKU ID
  function assignAttrs(skuId: string, collectedHashes: string[]) {
    if (!skuId) return;
    const existing = skuAttributes.get(skuId) || {};
    const attrs: Record<string, string> = { ...existing };

    for (const h of collectedHashes) {
      // Support comma-separated compound hashes
      const subHashes = h.includes(",") ? h.split(",").map((s) => s.trim()) : [h];
      for (const sub of subHashes) {
        const match = hashLookup.get(sub);
        if (match) {
          attrs[match.dimension] = match.value;
        }
      }
    }

    skuAttributes.set(skuId, attrs);
  }

  // 3. Recursive traversal of matrix
  function traverse(node: unknown, pathHashes: string[], previousRef?: string) {
    if (node === null || node === undefined) {
      return;
    }

    // Leaf: string or number representing SKU ID
    if (typeof node === "string" || typeof node === "number") {
      const allHashes = [...pathHashes];
      if (previousRef) allHashes.push(previousRef);
      assignAttrs(String(node), allHashes);
      return;
    }

    if (typeof node === "object") {
      const obj = node as Record<string, unknown>;

      // Check if node is an explicit leaf object with sku/id/sku_id/source_sku_id
      const explicitSku = obj.sku || obj.sku_id || obj.skuId || obj.source_sku_id;
      if (explicitSku && (typeof explicitSku === "string" || typeof explicitSku === "number")) {
        const allHashes = [...pathHashes];
        if (obj.previous && typeof obj.previous === "string") allHashes.push(obj.previous);
        if (obj.hash && typeof obj.hash === "string") allHashes.push(obj.hash);
        if (previousRef) allHashes.push(previousRef);
        assignAttrs(String(explicitSku), allHashes);
        return;
      }

      // Check for node-level previous reference
      const currentPrevious = typeof obj.previous === "string" ? obj.previous : previousRef;

      for (const [key, val] of Object.entries(obj)) {
        if (key === "previous" || key === "hash") continue;

        // If val is a string/number, check if key is compound hashes or single hash
        if (typeof val === "string" || typeof val === "number") {
          // If key is known to hashLookup or contains comma: key is combo -> val is skuId
          if (hashLookup.has(key) || key.includes(",")) {
            const allHashes = [...pathHashes, key];
            if (currentPrevious) allHashes.push(currentPrevious);
            assignAttrs(String(val), allHashes);
          } else {
            // key is skuId, val is hash combo
            const allHashes = [...pathHashes, String(val)];
            if (currentPrevious) allHashes.push(currentPrevious);
            assignAttrs(key, allHashes);
          }
        } else if (Array.isArray(val)) {
          // key is skuId, val is array of hashes
          const allHashes = [...pathHashes, ...val.map(String)];
          if (currentPrevious) allHashes.push(currentPrevious);
          assignAttrs(key, allHashes);
        } else if (typeof val === "object" && val !== null) {
          // Nested object: recurse
          traverse(val, [...pathHashes, key], currentPrevious);
        }
      }
    }
  }

  traverse(matrixDef, []);

  return skuAttributes;
}

/**
 * Normalizes stock semantics strictly according to Bagian 16 of Project Constitution and User Directives:
 * - CASE 1: in_stock === false -> OUT_OF_STOCK (available: false, exact: true, quantity: 0)
 * - CASE 2: in_stock === true && is_limited_stock === true && limited_stock != null -> available: true, exact: true, quantity: limited_stock
 * - CASE 3: in_stock === true && is_limited_stock === false -> available: true, exact: false, quantity: undefined
 * - Inconsistent: is_limited_stock === true && limited_stock == null -> UNKNOWN / INCOMPLETE
 * - Missing: in_stock == null/undefined -> UNKNOWN / INCOMPLETE
 */
export function normalizeStock(sku: JakmallRawSkuItem): {
  available: boolean | null;
  exact: boolean;
  quantity?: number | undefined;
  status: "in_stock" | "limited" | "out_of_stock" | "unknown";
} {
  const inStock = sku.in_stock;
  const isLimited = sku.is_limited_stock;
  const limitedStock =
    sku.limited_stock !== undefined && sku.limited_stock !== null
      ? typeof sku.limited_stock === "number"
        ? sku.limited_stock
        : Number(sku.limited_stock)
      : null;

  // Missing or non-boolean in_stock -> explicit UNKNOWN (available: null)
  if (inStock === null || inStock === undefined) {
    return {
      available: null,
      exact: false,
      quantity: undefined,
      status: "unknown",
    };
  }

  // CASE 1: in_stock == false -> OUT_OF_STOCK (confirmed 0 stock)
  if (inStock === false) {
    return {
      available: false,
      exact: true,
      quantity: 0,
      status: "out_of_stock",
    };
  }

  // inStock === true:
  // Inconsistent check: is_limited_stock === true BUT limited_stock === null / NaN
  if (isLimited === true) {
    if (limitedStock !== null && !isNaN(limitedStock) && limitedStock >= 0) {
      // CASE 2: in_stock == true && is_limited_stock == true && limited_stock != null
      return {
        available: true,
        exact: true,
        quantity: limitedStock,
        status: "limited",
      };
    } else {
      // Inconsistent source data: claims limited stock but no valid quantity -> UNKNOWN (available: null)
      return {
        available: null,
        exact: false,
        quantity: undefined,
        status: "unknown",
      };
    }
  }

  // CASE 3: in_stock == true && is_limited_stock == false
  if (isLimited === false) {
    return {
      available: true,
      exact: false,
      quantity: undefined,
      status: "in_stock",
    };
  }

  // If is_limited_stock is missing/undefined while in_stock is true -> UNKNOWN (available: null)
  return {
    available: null,
    exact: false,
    quantity: undefined,
    status: "unknown",
  };
}

/**
 * Normalizes SKU images to CanonicalImage array with deduplication and priority:
 * detail -> thumbnail -> icon.
 */
export function normalizeImages(
  skuImages?: JakmallRawSkuItem["images"]
): CanonicalImage[] {
  if (!skuImages || !Array.isArray(skuImages)) {
    return [];
  }

  const results: CanonicalImage[] = [];
  const seenUrls = new Set<string>();

  for (let i = 0; i < skuImages.length; i++) {
    const img = skuImages[i];
    let preferredUrl: string | undefined;

    if (typeof img === "string") {
      preferredUrl = img;
    } else if (img && typeof img === "object") {
      preferredUrl = img.detail || img.thumbnail || img.icon;
    }

    if (preferredUrl && !seenUrls.has(preferredUrl)) {
      seenUrls.add(preferredUrl);
      results.push({
        url: preferredUrl,
        sourceUrl: preferredUrl,
        position: results.length + 1,
      });
    }
  }

  return results;
}

/**
 * Normalizes raw parsed JakMall data into the project's CanonicalProduct model.
 * Enforces strict price verification (never falls back to Rp0).
 */
export function normalizeToCanonical(
  parsed: ParsedJakmallPage,
  sourceUrl: string
): CanonicalProduct {
  const { spdt, title, description, brand, categoryPath, specifications } = parsed;
  const productId = String(spdt.id);

  // Resolve attributes matrix
  const matrixAttributes = resolveVariantAttributes(
    spdt.variants,
    spdt.matrix
  );

  const canonicalVariants: CanonicalVariant[] = [];
  const allImagesMap = new Map<string, CanonicalImage>();

  for (const [skuKey, skuData] of Object.entries(spdt.sku)) {
    // Source identity: sourceSkuId, merchantSku, displaySku
    const sourceSkuId = String(skuData.id || skuKey);
    const merchantSku =
      skuData.sku !== null && skuData.sku !== undefined && String(skuData.sku).trim() !== ""
        ? String(skuData.sku)
        : undefined;
    const displaySku =
      skuData.sku_display !== null && skuData.sku_display !== undefined && String(skuData.sku_display).trim() !== ""
        ? String(skuData.sku_display)
        : undefined;

    // Attributes match by sourceSkuId, id, skuKey, or merchantSku
    const attributes =
      matrixAttributes.get(sourceSkuId) ||
      matrixAttributes.get(skuKey) ||
      (merchantSku ? matrixAttributes.get(merchantSku) : undefined) ||
      {};

    // Authoritative Price Validation:
    // Missing, null, or non-positive price MUST NOT become Rp0; it must throw!
    const rawFinalPrice = skuData.price?.final;
    if (rawFinalPrice === null || rawFinalPrice === undefined || rawFinalPrice === "") {
      throw new JakmallNormalizerError(
        `SKU ${sourceSkuId} is missing authoritative final price`,
        "MISSING_PRICE"
      );
    }
    const finalPriceNum = typeof rawFinalPrice === "number" ? rawFinalPrice : Number(rawFinalPrice);
    if (isNaN(finalPriceNum) || finalPriceNum <= 0) {
      throw new JakmallNormalizerError(
        `SKU ${sourceSkuId} has invalid or non-positive final price: ${rawFinalPrice}`,
        "INVALID_PRICE"
      );
    }
    const finalPrice = Math.round(finalPriceNum);

    const listPrice =
      skuData.price?.list !== null && skuData.price?.list !== undefined
        ? Math.round(Number(skuData.price.list))
        : undefined;
    const normalPrice =
      skuData.price?.normal !== null && skuData.price?.normal !== undefined
        ? Math.round(Number(skuData.price.normal))
        : undefined;

    const inventory = normalizeStock(skuData);
    const images = normalizeImages(skuData.images);

    for (const img of images) {
      if (!allImagesMap.has(img.url)) {
        allImagesMap.set(img.url, { ...img, position: allImagesMap.size + 1 });
      }
    }

    const weightGrams =
      skuData.weight !== null && skuData.weight !== undefined && !isNaN(Number(skuData.weight))
        ? Number(skuData.weight)
        : undefined;

    let isPreorder = false;
    if (skuData.pre_order === true) {
      isPreorder = true;
    } else if (isRecord(skuData.pre_order)) {
      const rawStatus = skuData.pre_order.enabled ?? skuData.pre_order.is_active ?? skuData.pre_order.status;
      isPreorder = Boolean(rawStatus);
    }

    canonicalVariants.push({
      sourceSkuId,
      sourceSku: sourceSkuId, // backward-compatible alias
      merchantSku,
      displaySku,
      attributes,
      price: {
        list: listPrice,
        normal: normalPrice,
        final: finalPrice,
      },
      inventory,
      weightGrams,
      preorder: {
        enabled: isPreorder,
      },
      images,
      sourceMetadata: {
        isComingSoon: Boolean(skuData.is_coming_soon),
        isNew: Boolean(skuData.is_new),
        weightInfo: skuData.weight_information,
      },
    });
  }

  const storeObj = spdt.store as Record<string, unknown> | undefined;
  const sellerName = String(storeObj?.name || "JakMall Seller");
  const sellerId = storeObj?.id ? String(storeObj.id) : undefined;

  return {
    source: "jakmall",
    sourceProductId: productId,
    sourceUrl,
    title,
    description,
    brand: brand || undefined,
    categoryPath,
    variants: canonicalVariants,
    images: Array.from(allImagesMap.values()),
    specifications: specifications || {},
    seller: {
      id: sellerId,
      name: sellerName,
    },
    fetchedAt: new Date(),
    sourceMetadata: {
      sold: spdt.sold,
      rating: spdt.rating,
    },
  };
}
