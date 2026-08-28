export interface CanonicalImage {
  url: string;
  sourceUrl: string;
  position?: number | undefined;
}

export interface CanonicalVariantInventory {
  available: boolean | null;
  exact: boolean;
  quantity?: number | undefined;
  status?: "in_stock" | "limited" | "out_of_stock" | "unknown" | undefined;
}

export interface CanonicalVariantPrice {
  list?: number | undefined;
  normal?: number | undefined;
  final: number;
}

export interface CanonicalVariantPreorder {
  enabled: boolean;
  estimatedShipDate?: string | undefined;
}

export interface CanonicalVariant {
  sourceSkuId: string;
  sourceSku: string; // Backward-compatible alias to sourceSkuId
  merchantSku?: string | undefined;
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

export interface CanonicalProductSeller {
  id?: string | undefined;
  name: string;
}

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
