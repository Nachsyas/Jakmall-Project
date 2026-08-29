# Canonical Product Model Contract

## 1. Concept
The `CanonicalProduct` model is the canonical, source-agnostic contract between source adapters (JakMall) and downstream marketplace adapters (Shopee). It isolates marketplace-specific nuances from core domain logic and ensures that source reality is captured faithfully without lossy or conjectural data transformations.

---

## 2. Interface Definitions

### CanonicalProduct
```typescript
export interface CanonicalProduct {
  source: "jakmall";
  sourceProductId: string;
  sourceUrl: string;

  title: string;
  description: string;
  brand?: string | undefined;
  categoryPath: string[];

  variants: CanonicalVariant[];
  images: CanonicalImage[];
  specifications: Record<string, string>;

  seller: CanonicalProductSeller;
  fetchedAt: Date;
  sourceMetadata?: Record<string, unknown> | undefined;
}
```

### CanonicalVariant
```typescript
export interface CanonicalVariant {
  /** The immutable, unique source platform SKU identifier (e.g. "5502951494118") */
  sourceSkuId: string;
  /** Temporary backward-compatible alias mirroring sourceSkuId */
  sourceSku: string;
  /** Merchant-defined SKU code if provided by seller (e.g. "OMPKGKBK") */
  merchantSku?: string | undefined;
  /** User-facing display SKU provided by the source when explicitly present. It may be undefined. */
  displaySku?: string | undefined;

  attributes: Record<string, string>;
  price: CanonicalVariantPrice;
  inventory: CanonicalVariantInventory;
  weightGrams?: number | undefined;
  volume?: unknown;
  preorder?: CanonicalVariantPreorder | undefined;
  images: CanonicalImage[];
  sourceMetadata?: Record<string, unknown> | undefined;
}
```

### CanonicalVariantInventory
```typescript
export interface CanonicalVariantInventory {
  /**
   * Boolean availability flag:
   * - true: Variant is confirmed in stock.
   * - false: Variant is confirmed OUT OF STOCK (quantity === 0).
   * - null: Source availability is UNKNOWN or incomplete.
   */
  available: boolean | null;
  /** Indicates whether the quantity field represents an exact verified integer */
  exact: boolean;
  /** Concrete stock count when known and exact; undefined when undisclosed */
  quantity?: number | undefined;
  /** Status classification */
  status?: "in_stock" | "limited" | "out_of_stock" | "unknown" | undefined;
}
```

> [!IMPORTANT]
> **Semantic Meaning of `available: null`:**
> `available: null` means source availability is **UNKNOWN or incomplete** (e.g. source payload missing inventory block or inconsistent flags such as `is_limited_stock: true` with `limited_stock: null`). It must **never** be conflated with `available: false` (confirmed out of stock). Downstream marketplace policies must block or flag `available: null` variants for human review.

### Supporting Contracts
```typescript
export interface CanonicalVariantPrice {
  list?: number | undefined;
  normal?: number | undefined;
  final: number; // authoritative integer IDR (> 0)
}

export interface CanonicalVariantPreorder {
  enabled: boolean;
  estimatedShipDate?: string | undefined;
}

export interface CanonicalImage {
  url: string;
  sourceUrl: string;
  position?: number | undefined;
}

export interface CanonicalProductSeller {
  id?: string | undefined;
  name: string;
}
```

---

## 3. Guarantees & Constraints
1. **Source Identity Integrity:** `sourceSkuId`, `merchantSku`, and `displaySku` represent distinct conceptual layers. Display labels (e.g. `"CPD65-PRO"`) are never artificially fabricated into `sku_display` or `sourceSkuId` unless literally present in source data.
2. **No Shopee-Specific Fields:** Canonical models must never contain Shopee category IDs, Shopee logistic channel codes, or Shopee-specific listing IDs.
3. **Strict Price Integrity:** `price.final` is strictly validated at the canonical boundary to be a positive integer in IDR. Missing, null, or zero prices are strictly blocked and throw `MISSING_PRICE` or `INVALID_PRICE`.
4. **Disclose Unknown Stock Truthfully:** If JakMall confirms `in_stock: true` but omits `limited_stock`, inventory is normalized to `available: true, exact: false, quantity: undefined`. It is never arbitrarily converted to 0 or an invented positive quantity.
5. **Integer IDR & Gram Weight:** Prices are always whole integer Rupiah; variant weights are strictly in grams.
6. **End-to-End Type Safety:** Zero usage of `any` across the entire domain layer.
