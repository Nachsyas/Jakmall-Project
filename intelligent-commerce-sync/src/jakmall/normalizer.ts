import type {
  CanonicalProduct,
  CanonicalVariant,
  CanonicalImage,
} from "../canonical/types.js";
import type {
  ParsedJakmallPage,
  JakmallProduct,
  JakmallVariant,
  JakmallStock,
  JakmallPrice,
  JakmallRawSkuItem,
} from "./types.js";

/**
 * Resolves attribute combinations for each SKU using spdt.variants and spdt.matrix.
 * Supports arbitrary dimension counts (generic multi-dimensional traversal).
 */
export function resolveVariantAttributes(
  variantsDef?: Record<string, unknown>,
  matrixDef?: Record<string, unknown>
): Map<string, Record<string, string>> {
  const skuAttributes = new Map<string, Record<string, string>>();

  if (!matrixDef) {
    return skuAttributes;
  }

  // Dimension value lookup: Map<hashId, { dimensionName: string, valueName: string }>
  const hashLookup = new Map<string, { dimension: string; value: string }>();

  if (variantsDef) {
    for (const [dimName, dimValues] of Object.entries(variantsDef)) {
      if (typeof dimValues === "object" && dimValues !== null) {
        for (const [valHash, valName] of Object.entries(dimValues)) {
          hashLookup.set(String(valHash), {
            dimension: dimName,
            value: String(valName),
          });
        }
      }
    }
  }

  // Traverse matrix entries:
  // Matrix format can be { "hash1,hash2": "skuId" } or { "skuId": "hash1,hash2" } or { "skuId": { ... } }
  for (const [key, val] of Object.entries(matrixDef)) {
    let skuId: string;
    let hashes: string[] = [];

    if (typeof val === "string") {
      // If key contains commas, it's combo -> skuId
      if (key.includes(",") || hashLookup.has(key)) {
        hashes = key.split(",").map((s) => s.trim());
        skuId = val;
      } else {
        // key is skuId, val is comma-separated hashes
        skuId = key;
        hashes = val.split(",").map((s) => s.trim());
      }
    } else {
      skuId = key;
    }

    const attrs: Record<string, string> = {};
    for (const h of hashes) {
      const match = hashLookup.get(h);
      if (match) {
        attrs[match.dimension] = match.value;
      }
    }

    skuAttributes.set(skuId, attrs);
  }

  return skuAttributes;
}

/**
 * Normalizes stock semantics strictly according to Bagian 16 of Project Constitution.
 */
export function normalizeStock(sku: JakmallRawSkuItem): {
  available: boolean;
  exact: boolean;
  quantity?: number | undefined;
} {
  const inStock = sku.in_stock !== false;
  const isLimited = Boolean(sku.is_limited_stock);
  const limitedStock = sku.limited_stock;

  // CASE 1: in_stock == false -> OUT_OF_STOCK
  if (!inStock) {
    return {
      available: false,
      exact: true,
      quantity: 0,
    };
  }

  // CASE 2: in_stock == true AND is_limited_stock == true AND limited_stock != null
  if (isLimited && limitedStock !== null && limitedStock !== undefined) {
    return {
      available: true,
      exact: true,
      quantity: Math.max(0, limitedStock),
    };
  }

  // CASE 3: in_stock == true AND is_limited_stock == false (exact stock unknown)
  return {
    available: true,
    exact: false,
    quantity: undefined,
  };
}

/**
 * Normalizes SKU images to CanonicalImage array with deduplication.
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
 */
export function normalizeToCanonical(
  parsed: ParsedJakmallPage,
  sourceUrl: string
): CanonicalProduct {
  const { spdt, title, description, brand, categoryPath } = parsed;
  const productId = String(spdt.id);

  // Resolve attributes matrix
  const matrixAttributes = resolveVariantAttributes(
    spdt.variants as Record<string, unknown> | undefined,
    spdt.matrix as Record<string, unknown> | undefined
  );

  const canonicalVariants: CanonicalVariant[] = [];
  const allImagesMap = new Map<string, CanonicalImage>();

  for (const [skuKey, skuData] of Object.entries(spdt.sku)) {
    const skuId = String(skuData.sku || skuData.id || skuKey);
    const attributes = matrixAttributes.get(skuId) || matrixAttributes.get(skuKey) || {};

    const finalPrice = Math.round(skuData.price?.final ?? 0);
    const listPrice = skuData.price?.list ? Math.round(skuData.price.list) : undefined;
    const normalPrice = skuData.price?.normal ? Math.round(skuData.price.normal) : undefined;

    const inventory = normalizeStock(skuData);
    const images = normalizeImages(skuData.images);

    for (const img of images) {
      if (!allImagesMap.has(img.url)) {
        allImagesMap.set(img.url, { ...img, position: allImagesMap.size + 1 });
      }
    }

    const weightGrams =
      typeof skuData.weight === "number" && !isNaN(skuData.weight)
        ? skuData.weight
        : undefined;

    const isPreorder = Boolean(
      typeof skuData.pre_order === "boolean"
        ? skuData.pre_order
        : skuData.pre_order && typeof skuData.pre_order === "object"
    );

    canonicalVariants.push({
      sourceSku: skuId,
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
    specifications: {},
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
