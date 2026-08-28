import * as cheerio from "cheerio";
import {
  JakmallRawSpdtSchema,
  type JakmallRawSpdt,
  type ParsedJakmallPage,
} from "./types.js";

export class JakmallParserError extends Error {
  constructor(
    message: string,
    public readonly code: string = "EXTRACTION_FAILED"
  ) {
    super(message);
    this.name = "JakmallParserError";
  }
}

/**
 * Extracts a JavaScript object literal assigned to a variable without executing eval().
 * Uses balanced brace parsing that respects string literals and escape characters.
 */
export function extractBalancedObject(source: string, variableName: string): string {
  const marker = `var ${variableName}`;
  const markerIndex = source.indexOf(marker);

  if (markerIndex === -1) {
    throw new JakmallParserError(
      `Variable ${variableName} declaration not found in script`,
      "VARIABLE_NOT_FOUND"
    );
  }

  const equalsIndex = source.indexOf("=", markerIndex);
  if (equalsIndex === -1) {
    throw new JakmallParserError(
      `Assignment operator for ${variableName} not found`,
      "ASSIGNMENT_NOT_FOUND"
    );
  }

  const startIndex = source.indexOf("{", equalsIndex);
  if (startIndex === -1) {
    throw new JakmallParserError(
      `Object opening brace for ${variableName} not found`,
      "OBJECT_BRACE_NOT_FOUND"
    );
  }

  let depth = 0;
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let endIndex = -1;

  for (let i = startIndex; i < source.length; i++) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringQuote = char;
      continue;
    }

    if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        endIndex = i + 1;
        break;
      }
    }
  }

  if (depth !== 0 || endIndex === -1) {
    throw new JakmallParserError(
      `Unbalanced object braces when parsing ${variableName}`,
      "UNBALANCED_OBJECT"
    );
  }

  return source.slice(startIndex, endIndex);
}

/**
 * Safely parses the extracted JavaScript object string into JSON.
 * Normalizes unquoted keys or trailing commas if necessary.
 */
export function safeParseJsObject(rawObjStr: string): unknown {
  try {
    return JSON.parse(rawObjStr);
  } catch {
    // If strict JSON.parse fails due to single quotes or unquoted keys,
    // apply safe regex normalization without using eval()
    const sanitized = rawObjStr
      // replace single-quoted strings with double-quoted strings
      .replace(/'((?:\\.|[^'])*)'/g, (_, content) => JSON.stringify(content))
      // quote unquoted object keys: { key: -> { "key":
      .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":')
      // remove trailing commas before closing braces/brackets
      .replace(/,\s*([}\]])/g, "$1");

    try {
      return JSON.parse(sanitized);
    } catch (parseError) {
      throw new JakmallParserError(
        `Failed to parse object as JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        "JSON_PARSE_ERROR"
      );
    }
  }
}

/**
 * Extracts embedded JSON-LD Product schema from HTML as a fallback or cross-validation source.
 */
export function extractJsonLdFallback($: cheerio.CheerioAPI): Record<string, unknown> | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const text = $(script).text().trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const product = parsed.find((item) => item && item["@type"] === "Product");
        if (product) return product as Record<string, unknown>;
      } else if (parsed && parsed["@type"] === "Product") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue to next script tag
    }
  }
  return null;
}

/**
 * Extracts product specifications from HTML specification tables and lists.
 */
export function extractSpecifications($: cheerio.CheerioAPI): Record<string, string> {
  const specs: Record<string, string> = {};

  // Table rows with 2 cells (label and value)
  $(
    "table.spec-table tr, .product-specification tr, .specification tr, #specification tr, .product-spec tr, table.table-specification tr"
  ).each((_, tr) => {
    const cells = $(tr).find("th, td").toArray();
    if (cells.length === 2) {
      const key = $(cells[0]).text().trim().replace(/[:：\s]+$/, "");
      const val = $(cells[1]).text().trim();
      if (key && val && key.length < 100 && val.length < 500 && !specs[key]) {
        specs[key] = val;
      }
    }
  });

  // Definition lists (dl dt / dd)
  $(".product-specification dl, .specification dl, dl.specs").each((_, dl) => {
    const dts = $(dl).find("dt").toArray();
    const dds = $(dl).find("dd").toArray();
    for (let i = 0; i < Math.min(dts.length, dds.length); i++) {
      const key = $(dts[i]).text().trim().replace(/[:：\s]+$/, "");
      const val = $(dds[i]).text().trim();
      if (key && val && !specs[key]) {
        specs[key] = val;
      }
    }
  });

  // Key-value items (.product-info-item, .spec-item, .dp__spec__row, etc.)
  $(".product-info-item, .spec-item, .specification-item, .dp__spec__row").each((_, el) => {
    const cols = $(el).find(".dp__spec__column").toArray();
    if (cols.length === 2) {
      const key = $(cols[0]).text().trim().replace(/[:：\s]+$/, "");
      const val = $(cols[1]).text().trim();
      if (key && val && !specs[key]) {
        specs[key] = val;
      }
      return;
    }
    const label = $(el).find(".label, .title, .key").text().trim().replace(/[:：\s]+$/, "");
    const value = $(el).find(".value, .desc, .text").text().trim();
    if (label && value && !specs[label]) {
      specs[label] = value;
    }
  });

  return specs;
}

/**
 * Extracts raw page data including text fields, specifications, and validated spdt object from JakMall HTML.
 */
export function parseJakmallHtml(html: string): ParsedJakmallPage {
  const $ = cheerio.load(html);

  // 1. Text extraction & sanitization
  const title =
    $("h1.product-title").text().trim() ||
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").text().trim();

  if (!title) {
    throw new JakmallParserError("Product title not found in HTML", "TITLE_NOT_FOUND");
  }

  // Sanitize description: isolate and strip scripts, styles, tracking tags
  const rawDesc =
    $(".product-description").html() ||
    $("#description").html() ||
    $('meta[name="description"]').attr("content") ||
    "";
  const desc$ = cheerio.load(rawDesc);
  desc$("script, style, noscript, iframe, link").remove();
  const description = desc$.text().trim();

  // Brand extraction: meta tags, product-brand link, or JSON-LD
  let brand =
    $('meta[property="product:brand"]').attr("content")?.trim() ||
    $('.product-brand a').text().trim() ||
    null;

  if (!brand) {
    const jsonLd = extractJsonLdFallback($);
    if (jsonLd) {
      const b = jsonLd["http://schema.org/brand"] || jsonLd.brand;
      if (b && typeof b === "object") {
        const bName = (b as any)["http://schema.org/name"] || (b as any).name;
        if (typeof bName === "string") brand = bName;
        else if (bName && typeof bName === "object" && typeof (bName as any).name === "string") {
          brand = (bName as any).name;
        }
      }
    }
  }

  // Breadcrumbs / category path
  const categoryPath: string[] = [];
  $(".breadcrumb a, .breadcrumb span, [itemprop='itemListElement'] a").each((_, el) => {
    const text = $(el).text().trim();
    if (
      text &&
      text.toLowerCase() !== "home" &&
      text.toLowerCase() !== "jakmall" &&
      !categoryPath.includes(text)
    ) {
      categoryPath.push(text);
    }
  });

  // Specifications
  const specifications = extractSpecifications($);

  // 2. Embedded spdt state extraction
  let rawSpdt: JakmallRawSpdt | null = null;
  const scriptTags = $("script").toArray();

  for (const script of scriptTags) {
    const content = $(script).html();
    if (content && content.includes("var spdt")) {
      try {
        const objStr = extractBalancedObject(content, "spdt");
        const parsed = safeParseJsObject(objStr);
        // Validate with Zod schema (Zero-Trust)
        const validation = JakmallRawSpdtSchema.safeParse(parsed);
        if (validation.success) {
          rawSpdt = validation.data;
          break;
        } else {
          throw new JakmallParserError(
            `spdt schema validation failed: ${validation.error.message}`,
            "EXTRACTION_VALIDATION_FAILED"
          );
        }
      } catch (err) {
        if (err instanceof JakmallParserError && err.code === "EXTRACTION_VALIDATION_FAILED") {
          throw err;
        }
        // If balanced brace extraction fails on this script, continue to next
      }
    }
  }

  // 3. Fallback to JSON-LD if spdt is not present
  if (!rawSpdt) {
    const jsonLd = extractJsonLdFallback($);
    if (!jsonLd) {
      throw new JakmallParserError(
        "Neither spdt embedded state nor valid JSON-LD found in HTML",
        "EXTRACTION_FAILED"
      );
    }

    // Inspect offers from JSON-LD safely (Product -> Offer / AggregateOffer / Array)
    const rawOffers = jsonLd.offers;
    let selectedOffer: Record<string, unknown> | undefined;

    if (Array.isArray(rawOffers)) {
      selectedOffer = rawOffers.find(
        (o) => o && typeof o === "object" && (o.price !== undefined || o.lowPrice !== undefined)
      ) as Record<string, unknown> | undefined;
    } else if (rawOffers && typeof rawOffers === "object") {
      selectedOffer = rawOffers as Record<string, unknown>;
    }

    const rawPriceVal = selectedOffer?.price ?? selectedOffer?.lowPrice;
    const priceNum =
      rawPriceVal !== undefined && rawPriceVal !== null ? Number(rawPriceVal) : NaN;

    if (isNaN(priceNum) || priceNum <= 0) {
      throw new JakmallParserError(
        "JSON-LD fallback lacks valid positive price",
        "EXTRACTION_FAILED"
      );
    }

    const fallbackId = String(jsonLd.sku || jsonLd.productID || "unknown");

    let availabilityStock: boolean | undefined;
    if (selectedOffer?.availability) {
      const availStr = String(selectedOffer.availability);
      if (availStr.includes("InStock")) {
        availabilityStock = true;
      } else if (availStr.includes("OutOfStock")) {
        availabilityStock = false;
      }
    }

    let weightVal: number | undefined;
    if (jsonLd.weight) {
      if (typeof jsonLd.weight === "number") {
        weightVal = jsonLd.weight;
      } else if (typeof jsonLd.weight === "object" && (jsonLd.weight as any).value) {
        weightVal = Number((jsonLd.weight as any).value);
      }
    }

    rawSpdt = {
      id: fallbackId,
      sku: {
        [fallbackId]: {
          id: fallbackId,
          sku: String(jsonLd.sku || fallbackId),
          price: {
            final: priceNum,
          },
          in_stock: availabilityStock,
          is_limited_stock: false,
          limited_stock: null,
          weight: weightVal,
        },
      },
    };
  }

  return {
    title,
    description,
    brand,
    categoryPath,
    specifications,
    spdt: rawSpdt,
  };
}