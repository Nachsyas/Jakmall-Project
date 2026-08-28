# Intelligent Product Sync Platform (JakMall → Shopee)

Platform sinkronisasi produk cerdas dari **JakMall** ke **Shopee** dengan arsitektur Modular Monolith, ekstraksi statis berkinerja tinggi, dan model data kanonikal type-safe.

---

## 📌 Problem & Solution

* **Problem:** Sinkronisasi manual katalog produk dari marketplace sumber (JakMall) ke channel penjualan (Shopee) memakan waktu, rawan kesalahan mapping varian (misal ukuran vs warna), rentan overselling akibat semantik stok yang keliru, dan lambat jika bergantung pada browser automation penuh.
* **Solution:** Menggunakan pendekatan **Static HTTP First** yang mengekstrak state `var spdt` terstruktur secara aman (tanpa `eval()`), menormalisasinya ke dalam kontrak `CanonicalProduct`, menyelesaikan matriks varian multidimensi, serta menerapkan aturan semantik harga & stok yang ketat sebelum listing ke marketplace tujuan.

---

## 🏗️ Architecture & Core Flow

```
JakMall Product URL
        ↓
SSRF Safe Fetcher (jakmall.com allowlist)
        ↓
Cheerio DOM + Balanced Brace spdt Extractor (JSON-LD Fallback)
        ↓
Zero-Trust Zod Schema Validation
        ↓
Canonical Normalizer (Multi-dimensional variant matrix resolution)
        ↓
CanonicalProduct Contract
        ↓
Shopee Marketplace Adapter (Phase 3)
```

---

## 🛠️ Tech Stack

* **Runtime & Language:** Node.js (v20+ / v25), TypeScript 5.8+ (Strict, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`)
* **Scraper / Parser:** Cheerio, Native Fetch (with SSRF protection), Custom Balanced-Brace AST parser
* **Schema Validation:** Zod
* **Test Runner:** Node.js Native Test Runner via `tsx`
* **Architecture:** Modular Monolith

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Run Typecheck & Unit Tests
```bash
# Type check with zero 'any'
npm run typecheck

# Run unit tests
npm test
```

---

## 🧪 Testing Coverage

Pengujian unit mencakup:
* SSRF protection (memblokir `localhost`, `127.0.0.1`, AWS metadata IP, `file://`, non-allowlisted host).
* Balanced brace extraction (mengurai kurung kurawal bersarang, string quotes, escape sequence).
* Semantik stok (in stock, limited exact stock, unknown quantity yang tidak memalsukan stok menjadi 0).
* Multi-dimensional variant matrix resolution (misal Ukuran $\times$ Warna $\rightarrow$ SKU).
* Normalisasi ke kontrak kanonikal `CanonicalProduct`.
* Fallback JSON-LD saat `spdt` tidak tersedia.

---

## 🔒 Security by Design

* **SSRF Protection:** URL input divalidasi dengan allowlist ketat (`jakmall.com`, `www.jakmall.com`), menolak seluruh private IP & loopback.
* **Zero Eval Execution:** Ekstraksi objek JavaScript menggunakan parser kedalaman brace mandiri, bukan `eval()` atau `Function()`.
* **Zero-Trust Validation:** Seluruh payload source divalidasi terhadap skema Zod sebelum dinormalisasi.
* **Type Safety:** 100% type-safe tanpa tipe `any`.

---

## 🤖 AI-Assisted Development Disclosure

* **Tooling:** Dikembangkan dengan panduan AI Agent Antigravity sesuai instruksi `PROMPT MASTER v1.0` dan Project Constitution.
* **Verifikasi:** Seluruh algoritma (balanced brace extractor, resolver matriks varian, SSRF guard) diverifikasi langsung melalui unit tests otomatis dan TypeScript compiler checks.
