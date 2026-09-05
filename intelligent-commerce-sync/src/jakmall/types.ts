import { z } from "zod";

export interface JakmallPrice {
  list: number | null;
  normal: number | null;
  final: number | null;
  discountPercentage: number | null;
}

export type JakmallStockStatus =
  | "in_stock"
  | "limited"
  | "out_of_stock"
  | "coming_soon"
  | "unknown";

export interface JakmallStock {
  status: JakmallStockStatus;
  quantity: number | null;
  exact: boolean;
}

export interface JakmallImage {
  icon?: string;
  thumbnail?: string;
  detail?: string;
}

export interface JakmallVariant {
  sourceSkuId: string;
  skuId: string; // Backward-compatible alias to sourceSkuId
  merchantSku?: string | null;
  displaySku?: string | null;
  attributes: Record<string, string>;
  price: JakmallPrice;
  stock: JakmallStock;
  weightGrams: number | null;
  images: JakmallImage[];
  preorder: boolean;
  sourceUrl: string;
}

export interface JakmallProduct {
  source: "jakmall";
  productId: string;
  sourceUrl: string;
  title: string;
  description: string;
  brand: string | null;
  categoryPath: string[];
  specifications: Record<string, string>;
  store: {
    id: string | null;
    name: string | null;
  };
  shippingOrigin: {
    city: string | null;
    location: string | null;
  };
  variants: JakmallVariant[];
  fetchedAt: string;
}

// Zod schemas for validating raw embedded spdt state from HTML
export const JakmallRawSkuImageSchema = z.object({
  icon: z.string().optional(),
  thumbnail: z.string().optional(),
  detail: z.string().optional(),
}).or(z.string());

export const JakmallRawSkuPriceSchema = z.object({
  list: z.union([z.number(), z.string()]).nullable().optional(),
  normal: z.union([z.number(), z.string()]).nullable().optional(),
  final: z.union([z.number(), z.string()]).nullable().optional(),
  discount_percentage: z.union([z.number(), z.string()]).nullable().optional(),
}).passthrough();

export const JakmallRawSkuItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  sku: z.union([z.string(), z.number()]).nullable().optional(),
  sku_display: z.union([z.string(), z.number()]).nullable().optional(),
  weight: z.union([z.number(), z.string()]).nullable().optional(),
  images: z.array(JakmallRawSkuImageSchema).optional(),
  in_stock: z.boolean().nullable().optional(),
  is_limited_stock: z.boolean().nullable().optional(),
  limited_stock: z.union([z.number(), z.string()]).nullable().optional(),
  is_coming_soon: z.boolean().nullable().optional(),
  is_new: z.boolean().nullable().optional(),
  price: JakmallRawSkuPriceSchema.nullable().optional(),
  pre_order: z.union([z.boolean(), z.record(z.string(), z.unknown())]).nullable().optional(),
  weight_information: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
}).passthrough();

export const JakmallRawSpdtSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().optional(),
  url: z.string().optional(),
  sku: z.record(z.string(), JakmallRawSkuItemSchema),
  variants: z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.record(z.string(), z.unknown())),
    ])
    .optional(),
  matrix: z.record(z.string(), z.unknown()).nullable().optional(),
  store: z.record(z.string(), z.unknown()).optional(),
  store_showcases: z.unknown().optional(),
  rating: z.unknown().optional(),
  sold: z.unknown().optional(),
}).passthrough();

export type JakmallRawSpdt = z.infer<typeof JakmallRawSpdtSchema>;
export type JakmallRawSkuItem = z.infer<typeof JakmallRawSkuItemSchema>;

export interface ParsedJakmallPage {
  title: string;
  description: string;
  brand: string | null;
  categoryPath: string[];
  specifications: Record<string, string>;
  spdt: JakmallRawSpdt;
}
