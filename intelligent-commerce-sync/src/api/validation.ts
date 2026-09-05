import { z } from "zod";
import { validateJakmallUrl } from "../jakmall/client.js";

export const CatalogDiscoverSchema = z.object({
  url: z
    .string()
    .min(5, "URL must not be empty")
    .max(2000, "URL is too long")
    .refine((val) => {
      try {
        validateJakmallUrl(val);
        return true;
      } catch {
        return false;
      }
    }, "Must be a valid JakMall HTTP/HTTPS URL (jakmall.com or www.jakmall.com)"),
  maxProducts: z.number().int().min(1).max(100).optional().default(20),
  maxPages: z.number().int().min(1).max(10).optional().default(2),
});

export const CatalogImportSchema = z.object({
  url: z
    .string()
    .min(5, "URL must not be empty")
    .max(2000, "URL is too long")
    .refine((val) => {
      try {
        validateJakmallUrl(val);
        return true;
      } catch {
        return false;
      }
    }, "Must be a valid JakMall HTTP/HTTPS URL (jakmall.com or www.jakmall.com)"),
  maxProducts: z.number().int().min(1).max(50).optional().default(10),
  maxPages: z.number().int().min(1).max(5).optional().default(2),
  persist: z.boolean().optional().default(true),
});

export const ProductListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  offset: z.coerce.number().int().min(0).optional().default(0),
  q: z.string().max(200).optional(),
  status: z.string().max(50).optional(),
});
