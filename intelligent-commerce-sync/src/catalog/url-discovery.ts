import { URL } from "node:url";
import * as cheerio from "cheerio";
import { validateJakmallUrl } from "../jakmall/client.js";
import type { CatalogPageScanResult, DiscoveredProductUrl } from "./types.js";

/**
 * Path segments that are definitively NOT product detail pages.
 * Any URL where any segment matches this set is immediately rejected.
 */
export const NON_PRODUCT_PATH_SEGMENTS = new Set([
  "",
  "member",
  "login",
  "register",
  "auth",
  "account",
  "user",
  "profile",
  "cart",
  "checkout",
  "payment",
  "purchase-history",
  "order",
  "orders",
  "status",
  "mitra",
  "affiliate",
  "help",
  "about",
  "contact",
  "terms",
  "privacy",
  "faq",
  "search",
  "cari",
  "static",
  "images",
  "assets",
  "css",
  "js",
  "media",
  "api",
  "_api",
  "panduan",
  "kebijakan",
  "syarat-ketentuan",
  "tracking",
  "hubungi-kami",
  "tentang-kami",
  "karir",
  "career",
  "blog",
  "news",
  "promo",
  "promosi",
  "flash-sale",
  "brands",
  "stores",
  "toko",
  "c",
  "kategori",
  "category",
  "watchlist",
  "recently-viewed",
  "store-reviews",
  "store-information",
  "store-statistics",
  "peluang-usaha",
  "top-100",
  "message",
  "inbox",
  "wishlist",
  "notification",
  "notifications",
]);

/**
 * Sub-paths of store pages that are tabs/sections, not individual products.
 */
export const STORE_SUB_SECTIONS = new Set([
  "info",
  "review",
  "reviews",
  "ulasan",
  "kebijakan",
  "diskusi",
  "etalase",
  "feedback",
  "products",
  "search",
  "tentang",
  "statistic",
  "statistics",
  "delivery",
  "warehouse-delivery",
]);

/**
 * Validates whether a normalized pathname represents a legitimate JakMall product detail page.
 * JakMall product detail URLs have strictly 2 path segments:
 * - Direct: /p/{product-slug} or /product/{product-slug}
 * - Store:  /{store-slug}/{product-slug}
 */
export function isJakmallProductUrlPath(pathname: string): boolean {
  if (!pathname || typeof pathname !== "string") {
    return false;
  }

  const cleanPath = pathname.replace(/^\/+|\/+$/g, "");
  if (!cleanPath) {
    return false;
  }

  const segments = cleanPath.split("/").filter((s) => s.length > 0);

  // JakMall product detail URLs have strictly 2 path segments
  if (segments.length !== 2) {
    return false;
  }

  const firstSegment = segments[0]!.toLowerCase();
  const secondSegment = segments[1]!.toLowerCase();

  // Reject if first segment is a known non-product keyword
  if (NON_PRODUCT_PATH_SEGMENTS.has(firstSegment)) {
    return false;
  }

  // Reject if second segment is a known non-product keyword
  if (NON_PRODUCT_PATH_SEGMENTS.has(secondSegment)) {
    return false;
  }

  // Reject if second segment is a store subsection / tab
  if (STORE_SUB_SECTIONS.has(secondSegment)) {
    return false;
  }

  // Direct product path prefix /p/{slug} or /product/{slug}
  if (firstSegment === "p" || firstSegment === "product") {
    return isValidProductSlug(secondSegment);
  }

  // Store-based product path /{store-slug}/{product-slug}
  if (!isValidStoreSlug(firstSegment)) {
    return false;
  }

  return isValidProductSlug(secondSegment);
}

function isValidStoreSlug(slug: string): boolean {
  if (slug.length < 2 || slug.length > 100) return false;
  // Store slug must be alphanumeric with hyphens/underscores
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(slug);
}

function isValidProductSlug(slug: string): boolean {
  if (slug.length < 3 || slug.length > 200) return false;
  // Slugs that are purely numbers or single words that resemble pagination are rejected
  if (/^\d+$/.test(slug)) return false;
  // Must be alphanumeric with hyphens/underscores
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(slug);
}

/**
 * Normalizes a candidate product URL:
 * 1. Resolves relative links safely against the current catalog base URL.
 * 2. Enforces JakMall host allowlisting and SSRF protections via `validateJakmallUrl`.
 * 3. Strips anchor fragments (e.g. `#skuId`) to deduplicate variants into a single canonical product.
 * 4. Filters out navigation, category, cart, static, and store-level links.
 * 5. Strips tracking query parameters and non-essential tokens (including jtm).
 * 6. Enforces positive 2-segment product path verification.
 *
 * Returns normalized URL string if valid product URL, or null if skipped/rejected.
 */
export function normalizeProductUrl(rawHref: string, basePageUrl: string): string | null {
  if (!rawHref || typeof rawHref !== "string") {
    return null;
  }

  const trimmed = rawHref.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("tel:")
  ) {
    return null;
  }

  let resolvedUrl: URL;
  try {
    resolvedUrl = new URL(trimmed, basePageUrl);
  } catch {
    return null;
  }

  // Enforce protocol and allowed hosts
  try {
    validateJakmallUrl(resolvedUrl.toString());
  } catch {
    return null;
  }

  // Canonicalize protocol to https and hostname to www.jakmall.com
  resolvedUrl.protocol = "https:";
  resolvedUrl.hostname = "www.jakmall.com";
  // Strip fragment
  resolvedUrl.hash = "";

  // Strip query parameters: JakMall product URLs are purely path-based
  resolvedUrl.search = "";

  // Clean trailing slashes for path evaluation
  let pathname = resolvedUrl.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  resolvedUrl.pathname = pathname;

  if (!isJakmallProductUrlPath(resolvedUrl.pathname)) {
    return null;
  }

  return resolvedUrl.toString();
}

/**
 * Extracts and normalizes the next page URL from catalog HTML pagination controls.
 */
export function extractNextPageUrl(
  $: cheerio.CheerioAPI,
  currentPageUrl: string,
  currentPageNumber: number
): string | null {
  // 1. Explicit rel="next"
  const relNextHref = $('a[rel="next"]').attr("href");
  if (relNextHref) {
    const resolved = resolvePaginationLink(relNextHref, currentPageUrl);
    if (resolved) return resolved;
  }

  // 2. Class-based "next" pagination buttons
  const nextBtnSelectors = [
    ".pagination .next a",
    ".pagination a.next",
    ".paging .next a",
    ".paging a.next",
    'a[aria-label="Next"]',
    'a[aria-label="Berikutnya"]',
  ];
  for (const selector of nextBtnSelectors) {
    const href = $(selector).attr("href");
    if (href) {
      const resolved = resolvePaginationLink(href, currentPageUrl);
      if (resolved) return resolved;
    }
  }

  // 3. Numeric pagination links where page number equals currentPageNumber + 1
  const nextPageTarget = currentPageNumber + 1;
  let foundNumericNext: string | null = null;

  $("a[href]").each((_, el) => {
    if (foundNumericNext) return;
    const text = $(el).text().trim();
    if (text === String(nextPageTarget)) {
      const href = $(el).attr("href");
      if (href) {
        const resolved = resolvePaginationLink(href, currentPageUrl);
        if (resolved) {
          foundNumericNext = resolved;
        }
      }
    }
  });

  return foundNumericNext;
}

export function resolvePaginationLink(href: string, basePageUrl: string): string | null {
  try {
    const resolved = new URL(href, basePageUrl);
    validateJakmallUrl(resolved.toString());
    resolved.protocol = "https:";
    resolved.hostname = "www.jakmall.com";
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Scans a catalog/store page's HTML to discover product URLs and next-page pagination.
 * Supports:
 * 1. Embedded JSON state (JakMall store/catalog pages embed product data in `var result = {"products": [...]}`)
 * 2. Static HTML DOM product card containers (e.g. .product-item, .catalog-item, etc.)
 */
export function scanCatalogPageHtml(
  html: string,
  pageUrl: string,
  pageNumber: number = 1
): CatalogPageScanResult {
  const seenUrls = new Set<string>();
  const productUrls: DiscoveredProductUrl[] = [];
  let nextPageUrl: string | null = null;

  // 1. Try extracting from embedded state `var result = {"products": [...], "pagination": {...}}`
  const scriptMatch = html.match(/var\s+result\s*=\s*(\{[\s\S]*?\});\s*(?:var\s+config|$|\n)/);
  if (scriptMatch && scriptMatch[1]) {
    try {
      const data = JSON.parse(scriptMatch[1]);
      if (Array.isArray(data.products) && data.products.length > 0) {
        // Prioritize products with populated variant records (higher confidence)
        const sortedProducts = [...data.products].sort((a, b) => {
          const aHasObj = a.variants && typeof a.variants === "object" && !Array.isArray(a.variants);
          const bHasObj = b.variants && typeof b.variants === "object" && !Array.isArray(b.variants);
          if (aHasObj && !bHasObj) return -1;
          if (!aHasObj && bHasObj) return 1;
          return 0;
        });

        for (const p of sortedProducts) {
          if (p && typeof p.url === "string") {
            const normalized = normalizeProductUrl(p.url, pageUrl);
            if (normalized && !seenUrls.has(normalized)) {
              seenUrls.add(normalized);
              const item: DiscoveredProductUrl = {
                url: normalized,
                rawHref: p.url,
                foundOnPage: pageNumber,
              };
              if (typeof p.name === "string" && p.name.trim().length > 0) {
                item.titleHint = p.name.trim();
              }
              productUrls.push(item);
            }
          }
        }
      }

      // Check pagination from embedded state
      if (data.pagination && typeof data.pagination.next === "string") {
        nextPageUrl = resolvePaginationLink(data.pagination.next, pageUrl);
      }
    } catch {
      // If embedded state JSON parsing fails, fall back cleanly to DOM extraction
    }
  }

  // 2. DOM extraction (for server-rendered HTML and offline fixtures)
  const $ = cheerio.load(html);

  // Safely remove non-product chrome navigation elements from the DOM tree
  $("header, footer, nav, .navbar, .header, .footer, #header, #footer, .sidebar, .member-menu, .user-menu, .top-nav, .navigation").remove();

  // First check product containers
  const containerSelectors = [
    ".product-item a[href]",
    ".product-item-dup a[href]",
    ".product-card a[href]",
    ".catalog-item a[href]",
    ".dp__item a[href]",
    "[data-product-id] a[href]",
    ".product-grid a[href]",
    ".product-list a[href]",
  ].join(", ");

  const containerAnchors = $(containerSelectors);
  const targetAnchors = containerAnchors.length > 0 ? containerAnchors : $("a[href]");

  targetAnchors.each((_, el) => {
    const rawHref = $(el).attr("href");
    if (!rawHref) return;

    const normalized = normalizeProductUrl(rawHref, pageUrl);
    if (!normalized) return;

    if (!seenUrls.has(normalized)) {
      seenUrls.add(normalized);
      const titleHint =
        $(el).attr("title")?.trim() ||
        $(el).find(".product-item__name, .product__title, h2, h3, span").first().text().trim() ||
        $(el).text().trim();

      const item: DiscoveredProductUrl = {
        url: normalized,
        rawHref,
        foundOnPage: pageNumber,
      };

      if (titleHint && titleHint.length > 0) {
        item.titleHint = titleHint;
      }

      productUrls.push(item);
    }
  });

  // If nextPageUrl not found from embedded state, check DOM pagination controls
  if (!nextPageUrl) {
    nextPageUrl = extractNextPageUrl($, pageUrl, pageNumber);
  }

  return {
    pageUrl,
    pageNumber,
    productUrls,
    nextPageUrl,
  };
}
