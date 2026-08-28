# Golden Fixtures Provenance & Verification Registry

Dokumen ini mencatat bukti asal-usul (*provenance*) resmi dan autentik dari seluruh *golden fixture* pengujian JakMall.

Seluruh fixture di bawah ini diklasifikasikan sebagai **`SANITIZED_REAL`**: diturunkan langsung dari tangkapan HTTP mentah (*raw payload*) halaman JakMall tanpa modifikasi atau rekonstruksi pada nilai-nilai penerimaan kritis (*acceptance-critical catalogue values*).

---

## Klasifikasi Fixture

1. **`SANITIZED_REAL`**: Diturunkan langsung dari tangkapan payload halaman JakMall aktual. Hanya menghapus skrip pelacak, sesi pengguna, token CSRF, dan chrome navigasi situs. Nilai katalog (ID, SKU, harga, stok, bobot, gambar, dimensi variasi) 100% identik dengan sumber.
2. **`SYNTHETIC_REGRESSION`**: Dibuat secara manual untuk menguji skenario algoritmik tepi tertentu.
3. **`SYNTHETIC_UNIT`**: Payload minimal buatan untuk unit testing terisolasi.

---

## 1. ACMIC CPD65 65W GaN Fast Charger

- **Klasifikasi:** `SANITIZED_REAL`
- **Authoritative Source URL:** `https://www.jakmall.com/acmic-official-store/acmic-cpd65-gan-65w-super-fast-charging-65-w-charger-pd-power-adapter#5502951494118`
- **Capture Timestamp:** `2026-08-29 01:06:00 WIB`
- **Product ID:** `6970238281488`
- **Expected SKU Count:** 9
- **SHA-256 Hash:** `b42c37f5c925d35fb9aa8f5208098228cd2081b1bc168bd030abb4eafafca838`
- **Dimension Key / Name:** `"2e35ea8e8b6fccc9ec2c813b4b661edaa535a68d"` / `"Lain-lain"`
- **Literal Raw Source SKU Properties:**
  1. `5502951494118` (CPD65 PRO Only): `sku: null`, `sku_display: "5502951494118"`, `price.final: 379000`, `in_stock: true`, `is_limited_stock: true`, `limited_stock: 3`, `weight: 230`, `pre_order: null`
  2. `7340637866967` (CPD65 PRO + Kabel): `sku: null`, `sku_display: "7340637866967"`, `price.final: 449000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  3. `9480799845218` (CPD65 LITE Only): `sku: null`, `sku_display: "9480799845218"`, `price.final: 299000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  4. `4395402255230` (DUO Mint Green): `sku: null`, `sku_display: "4395402255230"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  5. `4711519218246` (DUO Rose Pink): `sku: null`, `sku_display: "4711519218246"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  6. `7017009772176` (DUO Ice Blue): `sku: null`, `sku_display: "7017009772176"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  7. `5079585778025` (DUO Spring Lilac): `sku: null`, `sku_display: "5079585778025"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  8. `6470241162785` (DUO Black): `sku: null`, `sku_display: "6470241162785"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
  9. `8543126559080` (DUO White): `sku: null`, `sku_display: "8543126559080"`, `price.final: 399000`, `in_stock: false`, `is_limited_stock: true`, `limited_stock: 0`, `weight: 230`, `pre_order: null`
- **Fields Removed During Sanitization:** Sesi pengguna, cookie otentikasi, token CSRF, tracking pixel (Hotjar, Facebook Pixel), UI runtime scripts.
- **Statement of Integrity:** Seluruh nilai katalog sumber (Product ID `6970238281488`, 9 SKU IDs, harga, stok, bobot, dan matriks) dipertahankan langsung dari objek `var spdt` mentah tanpa pengubahan.

---

## 2. MOMO Tactical Cargo Pants

- **Klasifikasi:** `SANITIZED_REAL`
- **Authoritative Source URL:** `https://www.jakmall.com/shopping-mania/momo-celana-panjang-cargo-pria-tactical-waterproof-polyester-cotton-ap78#2715227285879`
- **Capture Timestamp:** `2026-08-29 01:06:00 WIB`
- **Product ID:** `7372731614335`
- **Expected SKU Count:** 1
- **SHA-256 Hash:** `df4cecadd017d2d10bc238a113ab5e6fcf7297770d6b1b67911226cb462da2d6`
- **Source SKU ID:** `2715227285879`
- **Merchant SKU:** `OMPKGKBK`
- **Display SKU:** `OMPKGKBK`
- **Dimensions:** `Ukuran = XL`, `Warna = Hitam` (hierarki bersarang: `Warna` dengan `previous: "fa95f36dafc0a1f751151112d8a7fa69d48f7710"` menunjuk ke `Ukuran`)
- **Final Price:** `119400`
- **Weight:** `800` gram
- **Stock Semantics:** `in_stock: true, is_limited_stock: false, limited_stock: null` $\rightarrow$ `available: true, exact: false, quantity: undefined`
- **Fields Removed During Sanitization:** Sesi pengguna, CSRF token, analytics pixels, header/footer global chrome.
- **Statement of Integrity:** Nilai Product ID `7372731614335`, SKU `2715227285879`, merchant SKU `OMPKGKBK`, harga Rp119.400, dan struktur matriks bersarang dipertahankan secara utuh.

---

## 3. ASV Raincoat Rubber PVC

- **Klasifikasi:** `SANITIZED_REAL`
- **Authoritative Source URL:** `https://www.jakmall.com/lstore/jas-hujan-asv-versi-1-kualitas-no1-rubber-press#3813346585186`
- **Capture Timestamp:** `2026-08-29 01:06:00 WIB`
- **Product ID:** `2389444540861`
- **Expected SKU Count:** 6
- **SHA-256 Hash:** `51e56d9e5fff8da71bbb99458c94d2cf7109450f8868e5f416e950c96792a84f`
- **Dimensions:** `Ukuran` (L, XL, XXL) $\times$ `Warna` (Hitam, Biru Tua)
- **Actual Source SKU IDs:**
  - L + Hitam $\rightarrow$ `3813346585186`
  - L + Biru Tua $\rightarrow$ `6072330745027`
  - XL + Hitam $\rightarrow$ `6165317079560`
  - XL + Biru Tua $\rightarrow$ `6162039043925`
  - XXL + Hitam $\rightarrow$ `3720859133975`
  - XXL + Biru Tua $\rightarrow$ `8827576919834`
- **Weight:** `1700` gram pada seluruh kombinasi
- **Final Price:** `190000` pada seluruh kombinasi
- **Stock Semantics:** `in_stock: true, is_limited_stock: false, limited_stock: null` $\rightarrow$ `available: true, exact: false, quantity: undefined`
- **Special Characteristics:** `sku: null`, `sku_display` berisi nomor SKU ID mentah, `pre_order: null`.
- **Fields Removed During Sanitization:** Sesi pengguna, CSRF token, analytics pixels, header/footer global chrome.
- **Statement of Integrity:** Product ID `2389444540861` dan seluruh 6 kombinasi matriks SKU dipertahankan secara utuh.
