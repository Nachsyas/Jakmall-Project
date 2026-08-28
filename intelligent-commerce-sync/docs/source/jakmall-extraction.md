# JakMall Extraction Strategy & Architecture

## 1. Overview
The primary extraction strategy is **Static HTTP First** (`fetch` + Cheerio + Balanced Brace Extraction).

JakMall product pages embed the authoritative client-side catalog state in a global JavaScript variable:
```javascript
var spdt = { ... };
```
Extracting this embedded state avoids heavy, slow, and brittle headless browser automation (Playwright), providing:
- High throughput (sub-second extraction vs 5-10s browser boot time)
- Low memory & CPU overhead
- High reliability and deterministic schema validation

---

## 2. Extraction Pipeline

```
HTTP GET (SSRF Protected)
        ↓
HTML Content
        ↓
Cheerio DOM Parse (Title, sanitized description, breadcrumbs)
        ↓
Find <script> with "var spdt"
        ↓
Balanced Brace Extractor (Depth tracking, string & escape aware)
        ↓
Safe JSON Parse (Zero eval() usage)
        ↓
Zod Schema Validation (Zero-Trust)
        ↓
Normalizer (Stock semantics, variant matrix resolution, canonical model)
```

---

## 3. Key Extraction Components

### A. Balanced Brace Parser (`extractBalancedObject`)
- Identifies `var spdt` and its opening brace `{`.
- Tracks nesting depth `depth++` on `{` and `depth--` on `}` while carefully skipping characters inside double-quotes, single-quotes, backticks, and escape sequences `\\`.
- Extracts the exact JSON-compatible object literal without using JavaScript `eval()` or `new Function()`.

### B. Fallback Strategy: JSON-LD
If `spdt` is absent or malformed:
1. Inspects `<script type="application/ld+json">`.
2. Extracts schema.org `@type: "Product"`.
3. Constructs a canonical fallback structure.

### C. Variant Matrix Resolution
- Multi-dimensional variant mapping: `spdt.variants` defines dimension hash tables (e.g. `Ukuran`, `Warna`).
- `spdt.matrix` maps combination hashes to SKU IDs.
- The extractor resolves these dynamically across arbitrary dimensions without hardcoded assumption of size/color.

### D. Stock Semantics
- `in_stock == false` $\rightarrow$ `available: false, exact: true, quantity: 0`
- `in_stock == true && is_limited_stock == true && limited_stock != null` $\rightarrow$ `available: true, exact: true, quantity: limited_stock`
- `in_stock == true && is_limited_stock == false` $\rightarrow$ `available: true, exact: false, quantity: undefined`
- **Important**: `limited_stock: null` does **not** mean quantity is 0; it means stock is available with unannounced exact quantity.

### E. Price & Weight Semantics
- `price.final` is the authoritative source price.
- Stored as integer IDR.
- `sku.weight` is captured directly in canonical grams.
