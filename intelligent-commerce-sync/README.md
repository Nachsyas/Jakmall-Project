# Intelligent Product Sync Platform
### JakMall → Shopee Intelligent Synchronization Engine

Platform sinkronisasi katalog e-commerce otomatis dari **JakMall** ke **Shopee Indonesia**, dirancang dengan arsitektur *modular monolith*, prinsip *Zero-Trust*, penanganan *Strict Stock & Price Semantics*, pemetaan marketplace cerdas, dan gerbang *Human-in-the-Loop Review*.

---

## 🚀 Quickstart

### 1. Setup Lingkungan
```bash
# Pastikan Node.js v20+ terpasang
npm install
```

### 2. Run Typecheck & Tests
```bash
# Type check with zero 'any'
npm run typecheck

# Run all unit, policy, mapper, adapter, verifier, and golden fixture regression tests
npm test
```

### 3. Run JakMall Extraction Diagnostic
```bash
# Run against local golden fixtures
npx tsx scripts/test-jakmall.ts tests/fixtures/acmic.html
npx tsx scripts/test-jakmall.ts tests/fixtures/momo.html
npx tsx scripts/test-jakmall.ts tests/fixtures/asv.html

# Run against a live JakMall URL
npx tsx scripts/test-jakmall.ts https://www.jakmall.com/baseus-store/baseus-encok-true-wireless-earphones-wm01
```

### 4. Run Shopee Listing Preparation & Review Preview
```bash
# Prepare Shopee draft listing, calculate prices/stock, and run dry-run simulation
npx tsx scripts/test-shopee-draft.ts tests/fixtures/acmic.html
npx tsx scripts/test-shopee-draft.ts tests/fixtures/momo.html
npx tsx scripts/test-shopee-draft.ts tests/fixtures/asv.html
```

---

## 🧪 Testing & Architecture Coverage

Pengujian otomatis mencakup **46 tests (0 suites)** yang memverifikasi:
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
* **JSON-LD Fallback:** Mendukung plain dan namespaced schema.org (`@type: Product`, `@type: http://schema.org/Product`, `Offer`, `AggregateOffer`, `offers[]`) dengan penolakan harga missing/non-positif secara ketat.
* **Marketplace Abstraction & Shopee Draft:** Kontrak `MarketplaceAdapter` terpisah dari detail Shopee; model `ShopeeListingDraft` independen dari `CanonicalProduct`.
* **Deterministic Pricing Policy:** Perhitungan markup berbasis persentase atau nominal tetap dengan pembulatan ke atas (*ceiling rounding*) ke kelipatan IDR terdekat (misal Rp1.000), penegakan margin minimum, dan penyangga biaya marketplace (*fee buffer*).
* **Deterministic Inventory Policy:** Stok konfirmasi OOS dipetakan ke 0, stok pasti dipetakan secara utuh, kuantitas tidak diungkap (*undisclosed*) dicegah dari penerbitan otomatis via `needs_review` atau dialokasikan via `safety_stock_fixed`, stok UNKNOWN diblokir mutlak.
* **Category & Attribute Mapping:** Aturan pemetaan kategori deterministik dan dukungan override manual tanpa ketergantungan wajib pada AI.
* **Zero Source Mutation Guarantee:** Pengujian snapshot regresi membuktikan bahwa `buildShopeeDraft` sama sekali tidak memodifikasi objek `CanonicalProduct`.
* **Human Review Gate:** Gerbang peninjauan eksplisit (`APPROVE`, `REJECT`, `EDIT_REQUIRED`) yang secara ketat mencegah draf dengan isu `BLOCKER` diterbitkan.
* **Dry-Run & Publish Safety Boundary:** Mode `dry_run` menghasilkan muatan simulasi tanpa request jaringan; mode `publish` menghentikan eksekusi dengan status `BLOCKED_BY_CREDENTIALS` jika kredensial resmi tidak dikonfigurasi (State B: Platform-Access-Limited E2E).
* **Read-After-Write Verifier:** Mesin verifikasi baca-ulang yang mendeteksi ketidaksesuaian (*mismatch*) judul, jumlah variasi, harga per varian, dan stok per varian pada listing marketplace remote.

---

## 🔒 Security by Design

* **SSRF Protection:** URL input divalidasi dengan allowlist ketat (`jakmall.com`, `www.jakmall.com`), menolak seluruh private IP & loopback.
* **Zero Eval Execution:** Ekstraksi objek JavaScript menggunakan parser kedalaman brace mandiri, bukan `eval()` atau `Function()`.
* **Zero-Trust Validation:** Seluruh payload source divalidasi terhadap skema Zod sebelum dinormalisasi.
* **Zero Fabrication Principle:** Platform tidak pernah memalsukan kredensial API atau mengklaim status `PUBLISHED` palsu.
* **Untrusted Content Boundary:** Deskripsi dan metadata HTML diperlakukan sebagai data mentah yang diisolasi, bukan instruksi.
* **Type Safety:** 100% type-safe tanpa tipe `any` di seluruh direktori `src/`.

---

## 🤖 AI-Assisted Development Disclosure

* **Tooling:** Dikembangkan dengan panduan AI Agent Antigravity sesuai instruksi `PROMPT CONTINUATION MASTER` dan Project Constitution.
* **Verifikasi:** Seluruh algoritma divalidasi langsung melalui real golden fixtures (`acmic.html`, `momo.html`, `asv.html`), unit tests otomatis (`npm test`), dan TypeScript compiler checks (`tsc --noEmit`).
