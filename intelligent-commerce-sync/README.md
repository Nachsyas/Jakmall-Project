# Intelligent Product Sync Platform (JakMall → Shopee)

Platform sinkronisasi produk cerdas dari **JakMall** ke **Shopee** dengan arsitektur Modular Monolith, ekstraksi statis berkinerja tinggi, dan model data kanonikal type-safe.

---

## 📌 Problem & Solution

* **Problem:** Sinkronisasi manual katalog produk dari marketplace sumber (JakMall) ke channel penjualan (Shopee) memakan waktu, rawan kesalahan mapping varian (misal ukuran vs warna), rentan overselling akibat semantik stok yang keliru, dan lambat jika bergantung pada browser automation penuh.
* **Solution:** Menggunakan pendekatan **Static HTTP First** yang mengekstrak state `var spdt` terstruktur secara aman (tanpa `eval()`), menormalisasinya ke dalam kontrak `CanonicalProduct`, menyelesaikan matriks varian multidimensi secara rekursif (termasuk relasi `previous`), serta menerapkan aturan semantik harga & stok yang ketat sebelum listing ke marketplace tujuan.

---

## 🏗️ Architecture & Core Flow

```
JakMall Product URL / HTML Fixture
        ↓
SSRF Safe Fetcher (jakmall.com allowlist)
        ↓
Cheerio DOM + Balanced Brace spdt Extractor (JSON-LD Fallback + Specs)
        ↓
Zero-Trust Zod Schema Validation (toleran terhadap sku: null, pre_order: null)
        ↓
Canonical Normalizer (Multi-dimensional recursive variant resolver + strict price & stock guards)
        ↓
CanonicalProduct Contract (sourceSkuId, merchantSku, displaySku)
        ↓
Shopee Marketplace Adapter (Phase 3)
```

---

## 🛠️ Tech Stack

* **Runtime & Language:** Node.js (v20+ / v25), TypeScript 5.8+ (Strict, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`)
* **Scraper / Parser:** Cheerio, Native Fetch (with SSRF protection), Custom Balanced-Brace AST parser
* **Schema Validation:** Zod (Zero-Trust)
* **Test Runner:** Node.js Native Test Runner via `tsx`
* **Architecture:** Modular Monolith

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Run Typecheck & Tests
```bash
# Type check with zero 'any'
npm run typecheck

# Run all unit and golden fixture regression tests
npm test
```

### 3. Run Diagnostic Utility
```bash
# Run against local golden fixtures
npx tsx scripts/test-jakmall.ts tests/fixtures/acmic.html
npx tsx scripts/test-jakmall.ts tests/fixtures/momo.html
npx tsx scripts/test-jakmall.ts tests/fixtures/asv.html

# Run against a live JakMall URL
npx tsx scripts/test-jakmall.ts https://www.jakmall.com/baseus-store/baseus-encok-true-wireless-earphones-wm01
```

---

## 🧪 Testing & Golden Regression Coverage

Pengujian otomatis mencakup 21 tests (0 suites) yang memverifikasi:
* **SSRF Protection:** Memblokir `localhost`, `127.0.0.1`, AWS metadata IP `169.254.169.254`, `file://`, non-allowlisted host.
* **Balanced Brace Extraction:** Mengurai kurung kurawal bersarang, string quotes, escape sequence tanpa JavaScript `eval()`.
* **Semantik Stok Ketat:**
  * Case 1: `in_stock = false` $\rightarrow$ `available: false, exact: true, quantity: 0, status: "out_of_stock"`
  * Case 2: `in_stock = true && is_limited_stock = true && limited_stock != null` $\rightarrow$ `available: true, exact: true, quantity: limited_stock, status: "limited"`
  * Case 3: `in_stock = true && is_limited_stock = false` $\rightarrow$ `available: true, exact: false, quantity: undefined, status: "in_stock"`
  * Inconsistent: `is_limited_stock = true && limited_stock = null` $\rightarrow$ explicit UNKNOWN (`available: null, status: "unknown"`)
  * Missing: `in_stock = undefined` $\rightarrow$ explicit UNKNOWN (`available: null`, tidak pernah otomatis available).
* **Price Safety:** Missing/null/non-positive price menolak konversi kanonikal dan tidak pernah menjadi Rp0.
* **Image Normalization & Deduplication:** Memverifikasi prioritas `detail` > `thumbnail` > `icon`, fallback bertingkat, deduplikasi URL yang sama, dan penomoran posisi sekuensial.
* **Golden Fixtures Regression (Real Data):**
  * **ACMIC CPD65:** Tepat me-resolve 9 source SKU dimensi `Lain-lain`, toleran terhadap `sku: null`, membedakan harga antar SKU (Rp379k, Rp449k, Rp299k, Rp399k), limited stock 3.
  * **MOMO Cargo:** Memisahkan `sourceSkuId` (`2715227285879`), `merchantSku` (`OMPKGKBK`), dan `displaySku`; me-resolve `Ukuran = XL` dan `Warna = Hitam`; mengabaikan deskripsi teks untuk varian aktif.
  * **ASV Raincoat:** Tepat me-resolve 6 kombinasi dimensi `Ukuran` $\times$ `Warna`, toleran `sku: null` dan `pre_order: null`, berat 1700g, harga 190.000.
* **Spesifikasi Produk:** Ekstraksi key-value dari tabel/list HTML ke `specifications`.
* **JSON-LD Fallback:** Mendukung plain dan namespaced schema.org (`@type: Product`, `@type: http://schema.org/Product`, `Offer`, `AggregateOffer`, `offers[]`) dengan penolakan harga missing/non-positif secara ketat.

---

## 🔒 Security by Design

* **SSRF Protection:** URL input divalidasi dengan allowlist ketat (`jakmall.com`, `www.jakmall.com`), menolak seluruh private IP & loopback.
* **Zero Eval Execution:** Ekstraksi objek JavaScript menggunakan parser kedalaman brace mandiri, bukan `eval()` atau `Function()`.
* **Zero-Trust Validation:** Seluruh payload source divalidasi terhadap skema Zod sebelum dinormalisasi.
* **Untrusted Content Boundary:** Deskripsi dan metadata HTML diperlakukan sebagai data mentah yang diisolasi, bukan instruksi.
* **Type Safety:** 100% type-safe tanpa tipe `any`.

---

## 🤖 AI-Assisted Development Disclosure

* **Tooling:** Dikembangkan dengan panduan AI Agent Antigravity sesuai instruksi `PROMPT CONTINUATION MASTER` dan Project Constitution.
* **Verifikasi:** Seluruh perbaikan algoritma divalidasi langsung melalui real golden fixtures (`acmic.html`, `momo.html`, `asv.html`), unit tests otomatis (`npm test`), dan TypeScript compiler checks (`tsc --noEmit`).
