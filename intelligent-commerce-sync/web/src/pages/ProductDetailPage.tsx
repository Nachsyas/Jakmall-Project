import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type ProductDetail, type ShopeePrepareResponse } from "../lib/api.js";
import { ImageWithFallback } from "../components/ImageWithFallback.js";
import { StatusIndicator } from "../components/StatusIndicator.js";

export const ProductDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Shopee Preparation State
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [shopeeDraft, setShopeeDraft] = useState<ShopeePrepareResponse | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    async function loadProduct() {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getProduct(id!);
        if (!cancelled) {
          setProduct(data);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Product not found";
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadProduct();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handlePrepareShopee = async () => {
    if (!id) return;
    setPreparing(true);
    setPrepareError(null);
    try {
      const res = await api.prepareShopee(id);
      setShopeeDraft(res);
      // Smooth scroll to Shopee Preparation panel
      const element = document.getElementById("shopee-preparation-panel");
      if (element) {
        element.scrollIntoView({ behavior: "smooth" });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to prepare Shopee draft";
      setPrepareError(msg);
    } finally {
      setPreparing(false);
    }
  };

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(price);
  };

  const renderStockText = (stock: { available: boolean | null; quantity: number | null; rawText: string | null }) => {
    if (stock.available === false) {
      return <span style={{ color: "var(--color-danger-text)", fontWeight: 500 }}>Out of stock</span>;
    }
    if (stock.quantity !== null && stock.quantity !== undefined) {
      return <span>{stock.quantity} available</span>;
    }
    if (stock.available === true) {
      return <span style={{ color: "var(--color-warning-text)" }}>Quantity undisclosed</span>;
    }
    return <span style={{ color: "var(--color-muted)" }}>Stock unknown</span>;
  };

  if (loading) {
    return (
      <main className="section-full section-light" style={{ minHeight: "80vh", textAlign: "center", paddingTop: "var(--spacing-3xl)" }}>
        <div className="container">
          <p style={{ color: "var(--color-muted)", fontSize: "17px" }}>Loading product details…</p>
        </div>
      </main>
    );
  }

  if (error || !product) {
    return (
      <main className="section-full section-light" style={{ minHeight: "80vh", textAlign: "center", paddingTop: "var(--spacing-3xl)" }}>
        <div className="container" style={{ maxWidth: "600px" }}>
          <h2 style={{ fontSize: "28px", color: "var(--color-danger-text)", marginBottom: "var(--spacing-sm)" }}>
            Product Not Found
          </h2>
          <p style={{ color: "var(--color-muted)", marginBottom: "var(--spacing-xl)" }}>
            {error || "The requested product could not be located in the database."}
          </p>
          <Link to="/products" className="btn btn-primary">
            Back to Products
          </Link>
        </div>
      </main>
    );
  }

  const primaryImage = product.images[activeImageIndex]?.url || product.images[0]?.url;

  return (
    <main>
      {/* SECTION 1: LIGHT — Product Hero & Information */}
      <section className="section-full section-light" style={{ paddingBottom: "var(--spacing-2xl)" }}>
        <div className="container">
          <div style={{ marginBottom: "var(--spacing-md)", fontSize: "14px" }}>
            <Link to="/products" style={{ color: "var(--color-action-blue)" }}>
              ← All Products
            </Link>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
              gap: "var(--spacing-2xl)",
              alignItems: "start",
            }}
          >
            {/* Left: Gallery */}
            <div>
              <div
                className="product-image-frame"
                style={{
                  height: "460px",
                  borderRadius: "var(--radius-card)",
                  backgroundColor: "var(--color-pearl)",
                  border: "1px solid var(--color-hairline)",
                  padding: "var(--spacing-lg)",
                }}
              >
                <ImageWithFallback
                  src={primaryImage}
                  alt={product.title}
                  loading="eager"
                  style={{ maxHeight: "400px", maxWidth: "100%" }}
                />
              </div>

              {/* Thumbnails */}
              {product.images.length > 1 && (
                <div
                  style={{
                    display: "flex",
                    gap: "var(--spacing-sm)",
                    marginTop: "var(--spacing-md)",
                    overflowX: "auto",
                    paddingBottom: "4px",
                  }}
                >
                  {product.images.map((img, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setActiveImageIndex(idx)}
                      style={{
                        width: "68px",
                        height: "68px",
                        padding: "4px",
                        borderRadius: "8px",
                        border: activeImageIndex === idx ? "2px solid var(--color-focus-blue)" : "1px solid var(--color-hairline)",
                        backgroundColor: "var(--color-pearl)",
                        cursor: "pointer",
                        outline: "none",
                        flexShrink: 0,
                      }}
                    >
                      <img
                        src={img.url}
                        alt={`Thumbnail ${idx + 1}`}
                        style={{ width: "100%", height: "100%", objectFit: "contain" }}
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Product Info */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-sm)" }}>
                <span style={{ fontSize: "13px", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                  {product.brand || "JakMall Source"}
                </span>
                <span style={{ color: "var(--color-hairline)" }}>•</span>
                <StatusIndicator status={product.status} />
              </div>

              <h1 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em", marginBottom: "var(--spacing-md)", lineHeight: 1.2 }}>
                {product.title}
              </h1>

              {/* Source Category Breadcrumbs */}
              {product.sourceCategoryPath && product.sourceCategoryPath.length > 0 && (
                <div style={{ fontSize: "13px", color: "var(--color-muted)", marginBottom: "var(--spacing-md)" }}>
                  {product.sourceCategoryPath.join(" › ")}
                </div>
              )}

              {/* Price Display */}
              <div style={{ margin: "var(--spacing-lg) 0", padding: "var(--spacing-md) 0", borderTop: "1px solid var(--color-hairline)", borderBottom: "1px solid var(--color-hairline)" }}>
                <div style={{ fontSize: "14px", color: "var(--color-muted)", marginBottom: "2px" }}>
                  Source Price
                </div>
                <div style={{ fontSize: "28px", fontWeight: 600, color: "var(--color-ink)" }}>
                  {product.variants.length > 0
                    ? formatPrice(product.variants[0]?.price.final ?? 0)
                    : "Price unavailable"}
                </div>
              </div>

              {/* Metadata summary */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)", marginBottom: "var(--spacing-xl)", fontSize: "14px" }}>
                <div>
                  <span style={{ color: "var(--color-muted)" }}>Total Variants:</span>{" "}
                  <strong>{product.variants.length}</strong>
                </div>
                <div>
                  <span style={{ color: "var(--color-muted)" }}>Source ID:</span>{" "}
                  <code>{product.sourceProductId}</code>
                </div>
                <div>
                  <span style={{ color: "var(--color-muted)" }}>Source Link:</span>{" "}
                  <a href={product.sourceUrl} target="_blank" rel="noopener noreferrer">
                    View on JakMall ↗
                  </a>
                </div>
              </div>

              {/* Primary Call to Action */}
              <div style={{ marginBottom: "var(--spacing-xl)" }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handlePrepareShopee}
                  disabled={preparing}
                  style={{ fontSize: "17px", minHeight: "48px", padding: "12px 28px", width: "100%", maxWidth: "320px" }}
                >
                  {preparing ? "Evaluating Shopee Draft…" : "Prepare for Shopee"}
                </button>
                {prepareError && (
                  <p style={{ color: "var(--color-danger-text)", fontSize: "14px", marginTop: "8px" }}>
                    {prepareError}
                  </p>
                )}
              </div>

              {/* Description preview */}
              {product.description && (
                <div style={{ fontSize: "15px", color: "var(--color-ink)", lineHeight: 1.6, maxHeight: "200px", overflowY: "auto", paddingRight: "8px" }}>
                  <h3 style={{ fontSize: "16px", marginBottom: "var(--spacing-xs)" }}>Description</h3>
                  <p style={{ whiteSpace: "pre-line", color: "#444" }}>
                    {product.description.length > 500 ? `${product.description.substring(0, 500)}…` : product.description}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* SECTION 2: PARCHMENT — Variants Table */}
      <section className="section-full section-parchment" style={{ borderTop: "1px solid var(--color-hairline)", borderBottom: "1px solid var(--color-hairline)" }}>
        <div className="container">
          <div style={{ marginBottom: "var(--spacing-lg)" }}>
            <h2 style={{ fontSize: "var(--font-size-title)", letterSpacing: "-0.015em" }}>Product Variants</h2>
            <p style={{ color: "var(--color-muted)", fontSize: "15px", marginTop: "4px" }}>
              Exact canonical variant data parsed from JakMall. Stock truth is strictly preserved.
            </p>
          </div>

          <div
            style={{
              backgroundColor: "var(--color-white)",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-hairline)",
              overflowX: "auto",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left", fontSize: "14px" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--color-hairline)", backgroundColor: "var(--color-pearl)" }}>
                  <th style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>Variant Name</th>
                  <th style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>Attributes</th>
                  <th style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>Source Price</th>
                  <th style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>Stock Status</th>
                  <th style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>SKU</th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((v, i) => (
                  <tr
                    key={v.id || i}
                    style={{
                      borderBottom: i < product.variants.length - 1 ? "1px solid var(--color-hairline)" : "none",
                    }}
                  >
                    <td style={{ padding: "14px 16px", fontWeight: 500, color: "var(--color-ink)" }}>
                      {v.name || `Variant ${i + 1}`}
                    </td>
                    <td style={{ padding: "14px 16px", color: "var(--color-muted)" }}>
                      {Object.entries(v.attributes || {}).map(([k, val]) => `${k}: ${val}`).join(", ") || "—"}
                    </td>
                    <td style={{ padding: "14px 16px", fontWeight: 600, color: "var(--color-ink)" }}>
                      {formatPrice(v.price.final)}
                    </td>
                    <td style={{ padding: "14px 16px" }}>
                      {renderStockText(v.stock)}
                    </td>
                    <td style={{ padding: "14px 16px", color: "var(--color-muted)", fontFamily: "monospace" }}>
                      {v.sku || v.sourceSkuId || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* SECTION 3: DARK — Shopee Preparation Panel */}
      <section id="shopee-preparation-panel" className="section-full section-dark">
        <div className="container">
          <div style={{ maxWidth: "800px", marginBottom: "var(--spacing-xl)" }}>
            <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-blue-on-dark)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Marketplace Readiness
            </span>
            <h2 style={{ fontSize: "var(--font-size-headline)", marginTop: "var(--spacing-xs)", marginBottom: "var(--spacing-sm)" }}>
              Shopee Listing Preparation
            </h2>
            <p style={{ color: "rgba(255, 255, 255, 0.7)", fontSize: "16px", lineHeight: 1.5 }}>
              Generated through deterministic Shopee policies. Category mappings, safety margins, and publication blockers are evaluated in DRY_RUN mode without live credentials.
            </p>
          </div>

          {!shopeeDraft ? (
            <div
              style={{
                backgroundColor: "#1e1e20",
                border: "1px dashed #444",
                borderRadius: "var(--radius-card)",
                padding: "var(--spacing-2xl)",
                textAlign: "center",
              }}
            >
              <h3 style={{ fontSize: "20px", color: "var(--color-white)", marginBottom: "var(--spacing-sm)" }}>
                Draft Not Yet Prepared
              </h3>
              <p style={{ color: "rgba(255, 255, 255, 0.6)", marginBottom: "var(--spacing-lg)", maxWidth: "480px", margin: "0 auto var(--spacing-lg) auto" }}>
                Click below to evaluate title sanitization, category matching, 20% margin calculation, and review blockers.
              </p>
              <button
                type="button"
                className="btn btn-dark-primary"
                onClick={handlePrepareShopee}
                disabled={preparing}
                style={{ fontSize: "15px", minHeight: "44px", padding: "10px 24px" }}
              >
                {preparing ? "Running Preparation Service…" : "Run Shopee Preparation"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
              {/* Status Banner */}
              <div
                style={{
                  backgroundColor: shopeeDraft.validation.canPublish ? "rgba(29, 124, 57, 0.15)" : "rgba(178, 94, 2, 0.15)",
                  border: `1px solid ${shopeeDraft.validation.canPublish ? "var(--color-success-text)" : "var(--color-warning-text)"}`,
                  borderRadius: "var(--radius-card)",
                  padding: "var(--spacing-lg)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--spacing-md)" }}>
                  <div>
                    <div style={{ fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.05em", color: "rgba(255, 255, 255, 0.6)", fontWeight: 600 }}>
                      Validation & Review State
                    </div>
                    <div style={{ fontSize: "22px", fontWeight: 600, color: "var(--color-white)", marginTop: "2px" }}>
                      {shopeeDraft.reviewStatus === "NEEDS_REVIEW" || shopeeDraft.reviewStatus === "PENDING"
                        ? "! Needs Operator Review"
                        : shopeeDraft.reviewStatus}
                    </div>
                    <p style={{ color: "rgba(255, 255, 255, 0.8)", fontSize: "14px", marginTop: "4px" }}>
                      {shopeeDraft.validation.canPublish
                        ? "Listing draft is fully validated and ready for review."
                        : "Review required before marketplace publication."}
                    </p>
                  </div>
                  <div>
                    <span
                      style={{
                        display: "inline-block",
                        padding: "6px 14px",
                        borderRadius: "var(--radius-pill)",
                        backgroundColor: "#333",
                        color: "var(--color-white)",
                        fontSize: "13px",
                        fontWeight: 500,
                      }}
                    >
                      Publishable: {shopeeDraft.validation.canPublish ? "True" : "False (Gated)"}
                    </span>
                  </div>
                </div>
              </div>

              {/* Detail Panels Grid */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "var(--spacing-lg)" }}>
                {/* Panel 1: Prepared Title & Category */}
                <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333" }}>
                  <h4 style={{ color: "var(--color-blue-on-dark)", fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "var(--spacing-md)" }}>
                    Listing Properties
                  </h4>
                  <div style={{ marginBottom: "var(--spacing-md)" }}>
                    <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Prepared Title:</div>
                    <div style={{ color: "var(--color-white)", fontWeight: 500, marginTop: "2px" }}>
                      {shopeeDraft.preparedTitle}
                    </div>
                  </div>
                  <div style={{ marginBottom: "var(--spacing-md)" }}>
                    <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Category Suggestion:</div>
                    <div style={{ color: "var(--color-white)", marginTop: "2px" }}>
                      {shopeeDraft.category.suggestion || "Unresolved"} (ID: {shopeeDraft.category.targetCategoryId || "None"})
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--color-blue-on-dark)", marginTop: "2px" }}>
                      Status: {shopeeDraft.category.status.toUpperCase()} ({shopeeDraft.category.method})
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Source Brand:</div>
                    <div style={{ color: "var(--color-white)", marginTop: "2px" }}>
                      {shopeeDraft.sourceBrand || "None (Unset)"}
                    </div>
                  </div>
                </div>

                {/* Panel 2: Pricing & Inventory */}
                <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333" }}>
                  <h4 style={{ color: "var(--color-blue-on-dark)", fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "var(--spacing-md)" }}>
                    Pricing & Stock Policy
                  </h4>
                  <div style={{ marginBottom: "var(--spacing-md)" }}>
                    <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Markup Policy:</div>
                    <div style={{ color: "var(--color-white)", marginTop: "2px" }}>
                      +20% Margin (percentage) • Rounding to 1.000 IDR
                    </div>
                  </div>
                  <div style={{ marginBottom: "var(--spacing-md)" }}>
                    <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Prepared Variants:</div>
                    <div style={{ color: "var(--color-white)", marginTop: "2px" }}>
                      {shopeeDraft.variants.length} mapped variations
                    </div>
                  </div>
                  {shopeeDraft.variants[0] && (
                    <div>
                      <div style={{ fontSize: "13px", color: "rgba(255, 255, 255, 0.6)" }}>Sample Price Calculation:</div>
                      <div style={{ color: "var(--color-white)", marginTop: "2px" }}>
                        Source: {formatPrice(shopeeDraft.variants[0].sourcePrice)} → Selling: <strong>{formatPrice(shopeeDraft.variants[0].sellingPrice)}</strong>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Blockers & Warnings */}
              <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333" }}>
                <h4 style={{ color: "var(--color-blue-on-dark)", fontSize: "14px", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: "var(--spacing-md)" }}>
                  Policy Audit & Issues ({shopeeDraft.validation.issues.length})
                </h4>

                {shopeeDraft.validation.blockers.length === 0 && shopeeDraft.validation.warnings.length === 0 ? (
                  <p style={{ color: "var(--color-success-text)", fontSize: "14px" }}>
                    ✓ Zero policy blockers or warnings found.
                  </p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
                    {shopeeDraft.validation.blockers.map((b, i) => (
                      <div key={i} style={{ color: "var(--color-danger-text)", fontSize: "14px", display: "flex", gap: "6px" }}>
                        <span>×</span> <span><strong>Blocker:</strong> {b}</span>
                      </div>
                    ))}
                    {shopeeDraft.validation.warnings.map((w, i) => (
                      <div key={i} style={{ color: "var(--color-warning-text)", fontSize: "14px", display: "flex", gap: "6px" }}>
                        <span>!</span> <span><strong>Warning:</strong> {w}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
};
