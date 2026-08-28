import { URL } from "node:url";

const ALLOWED_HOSTS = new Set(["www.jakmall.com", "jakmall.com"]);

export class JakmallClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "JakmallClientError";
  }
}

export function validateJakmallUrl(rawUrl: string): URL {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new JakmallClientError(`Invalid URL format: ${rawUrl}`, "INVALID_SOURCE_URL");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new JakmallClientError(`Unsupported protocol: ${parsedUrl.protocol}`, "SSRF_BLOCKED");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new JakmallClientError(
      `Hostname not allowed: ${hostname}. Only jakmall.com and www.jakmall.com are permitted.`,
      "SSRF_BLOCKED"
    );
  }

  return parsedUrl;
}

export interface JakmallFetchOptions {
  timeoutMs?: number;
  userAgent?: string;
}

export async function fetchJakmallHtml(
  rawUrl: string,
  options: JakmallFetchOptions = {}
): Promise<{ html: string; finalUrl: string }> {
  const validatedUrl = validateJakmallUrl(rawUrl);
  const timeoutMs = options.timeoutMs ?? 15000;
  const userAgent =
    options.userAgent ??
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(validatedUrl.toString(), {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    clearTimeout(timer);

    // Verify redirected URL for SSRF
    const finalUrl = response.url;
    validateJakmallUrl(finalUrl);

    if (response.status === 429) {
      throw new JakmallClientError(
        "Source rate limit reached (HTTP 429)",
        "SOURCE_RATE_LIMITED",
        429
      );
    }

    if (response.status === 404) {
      throw new JakmallClientError(
        `Product not found on JakMall (HTTP 404): ${rawUrl}`,
        "PRODUCT_NOT_FOUND",
        404
      );
    }

    if (!response.ok) {
      throw new JakmallClientError(
        `Failed to fetch JakMall page. HTTP ${response.status} ${response.statusText}`,
        "SOURCE_FETCH_FAILED",
        response.status
      );
    }

    const html = await response.text();
    return { html, finalUrl };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof JakmallClientError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new JakmallClientError(`Request timeout after ${timeoutMs}ms`, "SOURCE_FETCH_FAILED");
    }
    throw new JakmallClientError(
      `Network error fetching JakMall product: ${error instanceof Error ? error.message : String(error)}`,
      "SOURCE_FETCH_FAILED"
    );
  }
}
