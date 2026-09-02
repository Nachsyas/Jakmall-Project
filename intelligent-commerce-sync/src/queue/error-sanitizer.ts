/**
 * Error Sanitizer
 * Redacts secrets, tokens, and credentials from runtime error messages before persistence.
 */

const REDACTED = "[REDACTED]";

const REDACTION_PATTERNS: Array<{ pattern: RegExp; replacement: string | ((substring: string, ...args: string[]) => string) }> = [
  // URI user:password@host
  {
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s\/]+):([^\s@\/]+)@/gi,
    replacement: `$1:${REDACTED}@`,
  },
  // Authorization: Bearer <token>
  {
    pattern: /(authorization\s*:\s*bearer\s+)\S+/gi,
    replacement: `$1${REDACTED}`,
  },
  // Bearer <token>
  {
    pattern: /(bearer\s+)\S+/gi,
    replacement: `$1${REDACTED}`,
  },
  // Query param or key=value formats
  {
    pattern: /(access_token|accessToken|refresh_token|refreshToken|partner_key|partnerKey|client_secret|clientSecret|api_key|apiKey|password)=([^\s&;,]+)/gi,
    replacement: `$1=${REDACTED}`,
  },
  // Cookie or session key=value
  {
    pattern: /(cookie|session)=([^\s;]+)/gi,
    replacement: `$1=${REDACTED}`,
  },
  // JSON key-value pairs: "key": "value"
  {
    pattern: /"(access_token|accessToken|refresh_token|refreshToken|partner_key|partnerKey|client_secret|clientSecret|api_key|apiKey|password)"\s*:\s*"[^"]*"/gi,
    replacement: `"$1": "${REDACTED}"`,
  },
];

const ERROR_CODE_WHITELIST = /^[A-Z][A-Z0-9_]{0,49}$/;

export function sanitizeErrorMessage(rawError: unknown, maxLength = 1000): string {
  let rawMessage = "Unknown execution error";

  try {
    if (typeof rawError === "string") {
      rawMessage = rawError;
    } else if (rawError instanceof Error) {
      rawMessage = rawError.message;
    } else if (typeof rawError === "object" && rawError !== null) {
      if ("message" in rawError && typeof (rawError as Record<string, unknown>)["message"] === "string") {
        rawMessage = (rawError as Record<string, unknown>)["message"] as string;
      } else {
        rawMessage = String(rawError);
      }
    } else if (rawError !== null && rawError !== undefined) {
      rawMessage = String(rawError);
    }
  } catch {
    // Fail-safe against exploding getters/proxies
    rawMessage = "Unknown execution error";
  }

  let sanitized = rawMessage;

  try {
    for (const { pattern, replacement } of REDACTION_PATTERNS) {
      if (typeof replacement === "string") {
        sanitized = sanitized.replace(pattern, replacement);
      } else {
        sanitized = sanitized.replace(pattern, replacement);
      }
    }
  } catch {
    sanitized = "Unknown execution error";
  }

  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized;
}

export function extractSafeErrorCode(error: unknown): string {
  try {
    if (typeof error === "object" && error !== null) {
      const code = (error as Record<string, unknown>)["code"];
      if (typeof code === "string" && ERROR_CODE_WHITELIST.test(code)) {
        return code;
      }
    }
  } catch {
    // Fail closed on proxy/getter explosions
  }
  return "EXECUTION_ERROR";
}

export function normalizeErrorCode(rawCode: unknown): string {
  return extractSafeErrorCode({ code: rawCode });
}
