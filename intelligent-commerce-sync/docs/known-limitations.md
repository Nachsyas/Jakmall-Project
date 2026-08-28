# Known Limitations & Mitigations

| Limitation ID | Description | Impact | Current Mitigation | Future Improvement |
| :--- | :--- | :--- | :--- | :--- |
| **LIM-001** | JakMall HTML structure can mutate | Parser breaks if variable name or container changes | Zod schema validation + JSON-LD fallback + Extractor versioning | Playwright headless fallback for dynamic JS rendering |
| **LIM-002** | Exact stock not always disclosed | Non-limited items lack integer quantity | Normalized as `available: true, exact: false, quantity: undefined` without inventing fake stock | Configurable safety stock cap for unknown inventory |
| **LIM-003** | Upstream rate limits (HTTP 429) | Mass fetching blocked by source | Polite User-Agent, SSRF allowlist, 15s timeout | Exponential backoff, jitter, and Redis-backed token bucket |
| **LIM-004** | Category taxonomy mismatch | JakMall breadcrumb does not map 1:1 to Shopee categories | Rule-based mapping table with fallback | AI semantic category suggestion with confidence scoring |
