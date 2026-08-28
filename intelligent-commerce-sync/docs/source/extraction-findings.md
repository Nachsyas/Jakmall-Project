# Extraction Findings Log

This document records reverse-engineering findings and extraction observations across JakMall product pages.

---

### Finding: FIND-001
- **Status:** PROVEN
- **Observation:** Initial HTML contains embedded authoritative state in `var spdt = { ... };`.
- **Evidence:** Verified across electronics (ACMIC), apparel (MOMO, ASV), and accessory product pages.
- **Engineering Impact:** Static HTTP + balanced brace extraction is designated as the primary extractor, avoiding heavy headless browser overhead.

---

### Finding: FIND-002
- **Status:** PROVEN
- **Observation:** JakMall products support multi-dimensional variant combinations (e.g. `Ukuran` $\times$ `Warna`) as well as 1-dimensional lists (`Lain-lain`).
- **Evidence:** `spdt.variants` defines dimension lookup tables, while `spdt.matrix` maps compound key hashes to specific SKU IDs using nested structures or flat keys.
- **Engineering Impact:** Extractor and normalizer use recursive traversal supporting arbitrary dimensions and `previous` relationship ordering.

---

### Finding: FIND-003
- **Status:** PROVEN
- **Observation:** `limited_stock: null` indicates available stock with exact quantity undisclosed by seller when `in_stock: true && is_limited_stock: false`.
- **Evidence:** Products like MOMO Cargo and ASV Raincoat have `in_stock: true, is_limited_stock: false, limited_stock: null`.
- **Engineering Impact:** Normalizer preserves `exact: false, quantity: undefined` without defaulting to 0.

---

### Finding: FIND-004
- **Status:** PROVEN
- **Observation:** Secondary fallback schema exists in `<script type="application/ld+json">`.
- **Evidence:** HTML contains schema.org `@type: "Product"` with title, offers, and basic price information.
- **Engineering Impact:** Implemented as zero-dependency fallback extractor when `spdt` is missing or modified. Rejects non-positive or missing prices safely.

---

### Finding: FIND-005
- **Status:** PROVEN BUT LOGISTICS-ONLY
- **Observation:** `/_api/sku/{sku}/warehouse-delivery` endpoint exists.
- **Evidence:** Returns warehouse location and courier options.
- **Engineering Impact:** Do NOT use for primary stock, weight, or price. Use only for shipping origin metadata if needed.

---

### Finding: FIND-006
- **Status:** PROVEN
- **Observation:** Source `sku` can be `null`, numeric, or contain a merchant SKU.
- **Evidence:** ACMIC CPD65 and ASV Raincoat have multiple SKUs where `sku` is `null`. MOMO Cargo has internal SKU `2715227285879` and merchant SKU `OMPKGKBK`.
- **Engineering Impact:** Canonical contract separates `sourceSkuId`, `merchantSku`, and `displaySku`. Raw schema accepts nullable string or numeric values.

---

### Finding: FIND-007
- **Status:** PROVEN
- **Observation:** `pre_order` in `spdt` can be `null`.
- **Evidence:** ASV Raincoat and ACMIC CPD65 return `pre_order: null`.
- **Engineering Impact:** Raw schema permits nullable `pre_order`. Normalizer maps `null` to `preorder.enabled = false`.

---

### Finding: FIND-008
- **Status:** PROVEN
- **Observation:** Inconsistent stock states exist in source data.
- **Evidence:** If `is_limited_stock: true` but `limited_stock: null`, or `in_stock: undefined`.
- **Engineering Impact:** Mapped to explicit `status: "unknown"` with `available: false`, never silently assumed available or zero.
