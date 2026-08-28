# Canonical Product Model Contract

## 1. Concept
The `CanonicalProduct` model is the canonical, source-agnostic contract between source adapters (JakMall) and marketplace adapters (Shopee). It isolates marketplace-specific nuances from core domain logic.

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
  sourceSku: string;
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

### Supporting Contracts
```typescript
export interface CanonicalVariantInventory {
  available: boolean;
  exact: boolean;
  quantity?: number | undefined;
}

export interface CanonicalVariantPrice {
  list?: number | undefined;
  normal?: number | undefined;
  final: number; // authoritative integer IDR
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
1. **No Shopee-Specific Fields:** Canonical models must never contain Shopee category IDs, Shopee logistic channel codes, or Shopee-specific listing IDs.
2. **Integer IDR:** Prices are always expressed in whole integer Rupiah.
3. **Gram Weight:** Variant weights are strictly normalized to grams.
4. **End-to-End Type Safety:** Zero usage of `any`.
