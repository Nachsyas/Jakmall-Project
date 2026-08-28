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
 * Extracts embedded JSON-LD Product schema from HTML as a fallback.
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
 * Extracts raw page data including text fields and validated spdt object from JakMall HTML.
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

  // Brand extraction
  const brand =
    $('meta[property="product:brand"]').attr("content")?.trim() ||
    $('.product-brand a').text().trim() ||
    null;

  // Breadcrumbs / category path
  const categoryPath: string[] = [];
  $(".breadcrumb a, .breadcrumb span, [itemprop='itemListElement'] a").each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.toLowerCase() !== "home" && text.toLowerCase() !== "jakmall" && !categoryPath.includes(text)) {
      categoryPath.push(text);
    }
  });

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

    // Construct minimal spdt from JSON-LD
    const fallbackId = String(jsonLd.sku || jsonLd.productID || "unknown");
    const offers = jsonLd.offers as Record<string, unknown> | undefined;
    const priceVal = typeof offers?.price === "number" ? offers.price : Number(offers?.price || 0);

    rawSpdt = {
      id: fallbackId,
      sku: {
        [fallbackId]: {
          sku: fallbackId,
          price: {
            final: priceVal,
          },
          in_stock: offers?.availability?.toString().includes("InStock") ?? true,
        },
      },
    };
  }

  return {
    title,
    description,
    brand,
    categoryPath,
    spdt: rawSpdt,
  };
}