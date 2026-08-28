# System Overview & Architecture

## 1. Architectural Style: Modular Monolith
The platform adopts a **Modular Monolith** pattern. This maximizes velocity, reliability, and cognitive clarity for technical review while strictly maintaining bounded contexts.

```
┌────────────────────────────────────────────────────────┐
│                     Web Dashboard                      │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│                    Application Core                    │
├─────────────────┬───────────────────┬──────────────────┤
│  Source Engine  │    Sync Engine    │  Policy / Risk   │
├─────────────────┼───────────────────┼──────────────────┤
│ AI Intelligence │ Automation Engine │  Audit Logging   │
└────────┬────────┴───────────────────┴────────┬─────────┘
         │                                     │
┌────────▼──────────────┐             ┌────────▼─────────┐
│ JakMall SourceAdapter │             │  Shopee Adapter  │
└───────────────────────┘             └──────────────────┘
```

---

## 2. Core Modules

### A. Source Engine (`src/jakmall/`)
- `client.ts`: SSRF-protected HTTP client with domain allowlisting (`jakmall.com`, `www.jakmall.com`).
- `parser.ts`: Safe HTML parsing and balanced-brace JSON extraction for `var spdt = { ... }` with zero `eval()` and JSON-LD fallback.
- `normalizer.ts`: Maps raw source payloads to the canonical representation (`CanonicalProduct`).
- `adapter.ts`: Implements `SourceAdapter` contract (`fetchProduct`, `verifySource`).

### B. Canonical Layer (`src/canonical/`)
- Shared interfaces defining canonical products, variants, pricing, inventory, and images.

### C. Sync & Marketplace Engine (Phase 3 & Phase 4)
- Mapping canonical products into marketplace listing drafts.
- Idempotency key generation (`seller_account + source_product_id + marketplace`).
- Field-level diffing and risk checks.
