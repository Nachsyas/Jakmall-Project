# Shopee Open Platform Integration Architecture & Access Audit

Dokumen ini mendokumentasikan status audit bukti (*evidence audit*) integrasi Shopee Open Platform, batasan akses lingkungan saat ini, evaluasi protokol eksternal yang belum terverifikasi secara primer (*unverified candidate details*), serta arsitektur implementasi lokal pada platform Intelligent Product Sync.

---

## 1. Status Akses Bukti Dokumen Resmi (Official Document Access Status)

- **Dokumentasi Shopee Open Platform:** `PRIMARY_SOURCE_NOT_RETRIEVABLE_IN_CURRENT_AUDIT_ENVIRONMENT`
- **Alasan:** Situs resmi Shopee Open Platform tidak dapat diakses/diambil secara independen dalam lingkungan audit bukti saat ini (*network/session sandbox limitation*).
- **Implikasi Faktual:** Klaim detail protokol spesifik (URL endpoint, formula signature, parameter query, masa berlaku token) **TIDAK DAPAT** ditandai sebagai `VERIFIED` tanpa bukti primer (*primary source evidence*) yang tersimpan atau terakses langsung dalam repositori. Detail tersebut diperlakukan sebagai **Kandidat Integrasi (*Candidate / Expected Integration Details*)** yang wajib diverifikasi terhadap dokumen primer sebelum implementasi jaringan langsung (*live network implementation*).

---

## 2. Matriks Bukti Integrasi (Integration Evidence Matrix)

| Dimensi / Klaim | Status Bukti (*Evidence Status*) | Sumber Primer (*Primary Source*) | Terakhir Diperiksa |
|---|:---:|:---:|:---:|
| **Shopee Open Platform ada sebagai target integrasi** | `UNVERIFIED_PRIMARY_SOURCE_IN_CURRENT_ENV` | — | 2026-08-29 |
| **Production API base URL (`partner.shopeemobile.com`)** | `UNVERIFIED` | — | 2026-08-29 |
| **Sandbox API base URL (`partner.test-stable.shopeemobile.com`)** | `UNVERIFIED` | — | 2026-08-29 |
| **Algoritma signing HMAC-SHA256 & base string** | `UNVERIFIED` | — | 2026-08-29 |
| **Masa berlaku access token (4 jam) & refresh token (30 hari)** | `UNVERIFIED` | — | 2026-08-29 |
| **Toleransi timestamp drift (300 detik)** | `UNVERIFIED` | — | 2026-08-29 |
| **Endpoint Category API (`/api/v2/product/get_category`)** | `UNVERIFIED` | — | 2026-08-29 |
| **Endpoint Media Upload API (`/api/v2/media_space/upload_image`)** | `UNVERIFIED` | — | 2026-08-29 |
| **Kredensial Shopee aktif di environment proyek** | `NOT_CONFIGURED` | Audit Environment Lokal | 2026-08-29 |
| **Publikasi listing langsung ke remote Shopee** | `NOT_PERFORMED` | Bukti Eksekusi Proyek | 2026-08-29 |
| **Verifikasi baca-ulang langsung terhadap live Shopee** | `NOT_PERFORMED` | Bukti Eksekusi Proyek | 2026-08-29 |
| **Adapter dry-run & simulasi payload** | `IMPLEMENTED_AND_TESTED_LOCALLY` | `src/marketplace/shopee/adapter.ts` | 2026-08-29 |
| **Gerbang kredensial (`BLOCKED_BY_CREDENTIALS`)** | `IMPLEMENTED_AND_TESTED_LOCALLY` | `src/marketplace/shopee/adapter.ts` | 2026-08-29 |
| **Uji batas publikasi terotorisasi via mock transport** | `IMPLEMENTED_AND_TESTED_LOCALLY` | `tests/shopee-adapter.test.ts` | 2026-08-29 |
| **Uji pembaca verifier via mock reader** | `IMPLEMENTED_AND_TESTED_LOCALLY` | `tests/shopee-verifier.test.ts` | 2026-08-29 |
| **Peniadaan fabrikasi ID kategori numerik** | `VERIFIED_LOCALLY` | `src/marketplace/shopee/mapper.ts` | 2026-08-29 |
| **Mode eksekusi Phase 3 adalah State B** | `VERIFIED_LOCALLY` | `PROJECT_CHECKLIST.md` | 2026-08-29 |

---

## 3. Detail Kandidat Integrasi Protokol Eksternal (UNVERIFIED)

*Catatan: Seluruh rincian berikut merupakan kandidat rancangan integrasi berdasarkan pengetahuan arsitektur umum dan memerlukan verifikasi sumber primer resmi Shopee sebelum pemanggilan jaringan live diaktifkan.*

### A. Kandidat Endpoint Jaringan
- **Sandbox Environment:** `https://partner.test-stable.shopeemobile.com/api/v2` (`UNVERIFIED`)
- **Production Environment:** `https://partner.shopeemobile.com/api/v2` (`UNVERIFIED`)

### B. Kandidat Parameter Autentikasi & Request Signing
- **Komponen Kueri:** `partner_id`, `timestamp`, `access_token`, `shop_id`, `sign` (`UNVERIFIED`).
- **Kandidat Formula Tanda Tangan:**
  ```text
  base_string = partner_id + path + timestamp + access_token + shop_id
  sign = HMAC_SHA256(base_string, partner_key).to_hex_lowercase()
  ```
  *(Status: `UNVERIFIED` — belum diverifikasi terhadap dokumentasi resmi Shopee Open Platform).*

### C. Kandidat Endpoint Katalog & Media
- Add Item API: `POST /api/v2/product/add_item` (`UNVERIFIED`)
- Category Lookup: `GET /api/v2/product/get_category` (`UNVERIFIED`)
- Upload Image: `POST /api/v2/media_space/upload_image` (`UNVERIFIED`)
- Read Item Info: `GET /api/v2/product/get_item_base_info` (`UNVERIFIED`)

---

## 4. Fakta Terverifikasi Proyek Lokal (Project-Verified Facts)

Berikut adalah status faktual yang **terverifikasi secara langsung** melalui kode sumber, test runner, dan konfigurasi lingkungan repositori ini:

1. **Kredensial Tidak Dikonfigurasi (`NOT_CONFIGURED`):** Variabel `SHOPEE_PARTNER_ID`, `SHOPEE_PARTNER_KEY`, `SHOPEE_SHOP_ID`, dan `SHOPEE_ACCESS_TOKEN` tidak ada di environment lokal/CI.
2. **Publikasi Jaringan Langsung Tidak Dilakukan (`NOT_PERFORMED`):** Tidak ada request jaringan live yang dikirim ke server Shopee; operasi publish dihentikan secara aman oleh gerbang `BLOCKED_BY_CREDENTIALS`.
3. **Verifikasi Remote Langsung Tidak Dilakukan (`NOT_PERFORMED`):** Logika verifikasi baca-ulang hanya diuji terhadap status tiruan (*mock reader*) dalam lingkungan pengujian unit terisolasi.
4. **Transport Jaringan Live Tetap Non-Aktif:** Adapter menolak melakukan remote network call berbasis asumsi yang belum terverifikasi sumber primer.
5. **Mode Eksekusi:** Berjalan penuh pada **`STATE B — PLATFORM-ACCESS-LIMITED E2E`**, di mana draf divalidasi secara lengkap, disimulasikan dalam mode `dry_run`, dan dipagari secara ketat pada batas otorisasi.
