# Extraction Findings Log

This document records reverse-engineering findings and extraction observations across JakMall product pages.

---

### Finding: FIND-001
- **Status:** PROVEN
- **Observation:** Initial HTML contains embedded authoritative state in `var spdt = { ... };`.
- **Evidence:** Verified across electronics, apparel, and accessory product pages.
- **Engineering Impact:** Static HTTP + balanced brace extraction is designated as the primary extractor, avoiding heavy headless browser overhead.

---

### Finding: FIND-002
- **Status:** PROVEN
- **Observation:** JakMall products support multi-dimensional variant combinations (e.g. `Ukuran` $\times$ `Warna`).
- **Evidence:** `spdt.variants` defines dimension lookup tables, while `spdt.matrix` maps compound key hashes to specific SKU IDs.
- **Engineering Impact:** Extractor and normalizer must not assume 1-dimensional variants or hardcode attributes like size/color.

---

### Finding: FIND-003
- **Status:** PROVEN
- **Observation:** `limited_stock: null` indicates available stock with exact quantity undisclosed by seller, not zero stock.
- **Evidence:** Products with `in_stock: true` and `is_limited_stock: false` have `limited_stock: null` and can still be purchased.
- **Engineering Impact:** Normalizer must preserve `exact: false, quantity: undefined` instead of falsifying 0 stock.

---

### Finding: FIND-004
- **Status:** PROVEN
- **Observation:** Secondary fallback schema exists in `<script type="application/ld+json">`.
- **Evidence:** HTML contains schema.org `@type: "Product"` with title, offers, and basic price information.
- **Engineering Impact:** Implemented as zero-dependency fallback extractor when `spdt` is missing or modified.

---

### Finding: FIND-005
- **Status:** PROVEN BUT LOGISTICS-ONLY
- **Observation:** `/_api/sku/{sku}/warehouse-delivery` endpoint exists.
- **Evidence:** Returns warehouse location and courier options.
- **Engineering Impact:** Do NOT use for primary stock, weight, or price. Use only for shipping origin metadata if needed.
