# Field Ownership Matrix

To prevent infinite synchronization loops and unintentional overwriting of customized listing content, field ownership is strictly segregated across three domains:

---

## 1. Source-Owned (JakMall)
The system updates these fields from source snapshots. They represent objective supplier data:
- `source_price` (`price.final`, `price.normal`, `price.list`)
- `source_stock` / `source_availability`
- `source_sku`
- `source_variants` (raw attributes)
- `source_weight`
- `source_images`

---

## 2. System-Owned (Internal Logic & Policies)
Calculated deterministically by application policy rules:
- `selling_price` (Formula: `source_price + markup_policy`)
- `markup` (Percentage, fixed margin, or rounding rules)
- `safety_stock` (Reserve buffer before listing to Shopee)
- `category_mapping` (JakMall breadcrumb $\rightarrow$ Shopee taxonomy)
- `attribute_mapping` (JakMall attributes $\rightarrow$ Shopee required specifications)
- `sync_policy`
- `risk_decision`

---

## 3. Seller-Owned (Marketplace / Merchant)
Owned by the store operator on Shopee. Source synchronization is **STRICTLY FORBIDDEN** from automatically overwriting these fields:
- `marketing_title` (Optimized title for SEO/promotions)
- `custom_description` (Store terms, warranty notes, custom copy)
- `manual_category_override`
- `promotional_content` / vouchers
- `seller_specific_metadata`
