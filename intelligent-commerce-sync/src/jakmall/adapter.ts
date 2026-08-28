import type { CanonicalProduct } from "../canonical/types.js";
import { fetchJakmallHtml, validateJakmallUrl } from "./client.js";
import { parseJakmallHtml } from "./parser.js";
import { normalizeToCanonical } from "./normalizer.js";

export interface SourceHealth {
  healthy: boolean;
  status: "OK" | "DEGRADED" | "DOWN";
  latencyMs: number;
  message?: string;
}

export interface SourceAdapter {
  fetchProduct(url: string): Promise<CanonicalProduct>;
  verifySource(url: string): Promise<SourceHealth>;
}

export class JakMallSourceAdapter implements SourceAdapter {
  async fetchProduct(url: string): Promise<CanonicalProduct> {
    const { html, finalUrl } = await fetchJakmallHtml(url);
    const parsed = parseJakmallHtml(html);
    return normalizeToCanonical(parsed, finalUrl);
  }

  async verifySource(url: string): Promise<SourceHealth> {
    const start = Date.now();
    try {
      validateJakmallUrl(url);
      const { html } = await fetchJakmallHtml(url, { timeoutMs: 8000 });
      const parsed = parseJakmallHtml(html);
      const latencyMs = Date.now() - start;

      const hasSkus = Object.keys(parsed.spdt.sku).length > 0;
      return {
        healthy: hasSkus,
        status: hasSkus ? "OK" : "DEGRADED",
        latencyMs,
        message: hasSkus
          ? "Successfully verified JakMall product source"
          : "Product fetched but 0 SKUs found",
      };
    } catch (err) {
      return {
        healthy: false,
        status: "DOWN",
        latencyMs: Date.now() - start,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
