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
  skuId: string;
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
  list: z.number().nullable().optional(),
  normal: z.number().nullable().optional(),
  final: z.number(),
}).passthrough();

export const JakmallRawSkuItemSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  sku: z.string(),
  weight: z.number().nullable().optional(),
  images: z.array(JakmallRawSkuImageSchema).optional(),
  in_stock: z.boolean().optional(),
  is_limited_stock: z.boolean().optional(),
  limited_stock: z.number().nullable().optional(),
  is_coming_soon: z.boolean().optional(),
  is_new: z.boolean().optional(),
  price: JakmallRawSkuPriceSchema.optional(),
  pre_order: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(),
  weight_information: z.string().nullable().optional(),
  url: z.string().optional(),
}).passthrough();

export const JakmallRawSpdtSchema = z.object({
  id: z.union([z.string(), z.number()]),
  url: z.string().optional(),
  sku: z.record(z.string(), JakmallRawSkuItemSchema),
  variants: z.record(z.string(), z.unknown()).optional(),
  matrix: z.record(z.string(), z.unknown()).optional(),
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
  spdt: JakmallRawSpdt;
}
