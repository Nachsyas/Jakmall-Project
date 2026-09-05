import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProductSummary } from "../lib/api.js";
import { ProductCard } from "../components/ProductCard.js";

export const HomePage: React.FC = () => {
  const [productCount, setProductCount] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [jobCount, setJobCount] = useState<number | null>(null);
  const [latestProducts, setLatestProducts] = useState<ProductSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      setError(null);
      try {
        const [productsRes, reviewsRes, jobsRes] = await Promise.all([
          api.getProducts({ limit: 4 }),
          api.getReviews({ limit: 1 }),
          api.getJobs({ limit: 1 }),
        ]);

        if (!cancelled) {
          setProductCount(productsRes.total);
          setLatestProducts(productsRes.products);
          setReviewCount(reviewsRes.total);
          setJobCount(jobsRes.total);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load dashboard metrics";
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      {/* 1. Large Editorial Hero Section (Light) */}
      <section className="section-full section-pearl" style={{ textAlign: "center", paddingTop: "var(--spacing-3xl)", paddingBottom: "var(--spacing-3xl)" }}>
        <div className="container" style={{ maxWidth: "880px" }}>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-action-blue)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Intelligent Commerce Sync
          </span>
          <h1
            style={{
              fontSize: "var(--font-size-hero)",
              marginTop: "var(--spacing-md)",
              marginBottom: "var(--spacing-md)",
              letterSpacing: "-0.025em",
            }}
          >
            Your catalog. <br />
            In one place.
          </h1>
          <p
            style={{
              fontSize: "var(--font-size-subhead)",
              color: "var(--color-muted)",
              marginBottom: "var(--spacing-xl)",
              lineHeight: 1.4,
              maxWidth: "680px",
              margin: "0 auto var(--spacing-xl) auto",
            }}
          >
            Products from JakMall, prepared for Shopee through one controlled workflow.
          </p>

          <div style={{ display: "flex", gap: "var(--spacing-md)", justifyContent: "center", flexWrap: "wrap" }}>
            <Link to="/sync" className="btn btn-primary" style={{ fontSize: "17px", minHeight: "48px", padding: "12px 28px" }}>
              Sync JakMall
            </Link>
            <Link to="/products" className="btn btn-secondary" style={{ fontSize: "17px", minHeight: "48px", padding: "12px 28px" }}>
              Browse Catalog
            </Link>
          </div>
        </div>
      </section>

      {/* 2. Real API Statistics Row (Parchment) */}
      <section className="section-full section-parchment" style={{ borderTop: "1px solid var(--color-hairline)", borderBottom: "1px solid var(--color-hairline)", padding: "var(--spacing-2xl) var(--spacing-lg)" }}>
        <div className="container">
          {error && (
            <div
              style={{
                backgroundColor: "#fff0f0",
                border: "1px solid #ffcccc",
                borderRadius: "12px",
                padding: "var(--spacing-md)",
                marginBottom: "var(--spacing-lg)",
                color: "var(--color-danger-text)",
                fontSize: "14px",
              }}
            >
              <strong>API Connection Issue:</strong> {error}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "var(--spacing-xl)",
              textAlign: "center",
            }}
          >
            <div style={{ padding: "var(--spacing-md)" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Products
              </div>
              <div style={{ fontSize: "48px", fontWeight: 600, color: "var(--color-ink)", marginTop: "4px" }}>
                {loading ? "…" : productCount ?? 0}
              </div>
              <div style={{ fontSize: "14px", color: "var(--color-muted)", marginTop: "4px" }}>
                Imported from JakMall
              </div>
            </div>

            <div style={{ padding: "var(--spacing-md)" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Needs Review
              </div>
              <div style={{ fontSize: "48px", fontWeight: 600, color: (reviewCount ?? 0) > 0 ? "var(--color-warning-text)" : "var(--color-ink)", marginTop: "4px" }}>
                {loading ? "…" : reviewCount ?? 0}
              </div>
              <div style={{ fontSize: "14px", color: "var(--color-muted)", marginTop: "4px" }}>
                Requires operator confirmation
              </div>
            </div>

            <div style={{ padding: "var(--spacing-md)" }}>
              <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Recent Activity
              </div>
              <div style={{ fontSize: "48px", fontWeight: 600, color: "var(--color-ink)", marginTop: "4px" }}>
                {loading ? "…" : jobCount ?? 0}
              </div>
              <div style={{ fontSize: "14px", color: "var(--color-muted)", marginTop: "4px" }}>
                Sync operations recorded
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 3. Latest Products Section (Light) */}
      <section className="section-full section-light">
        <div className="container">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: "var(--spacing-xl)" }}>
            <div>
              <h2 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em" }}>Latest Products</h2>
              <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-body)", marginTop: "4px" }}>
                Recently synchronized from the JakMall catalog.
              </p>
            </div>
            {latestProducts.length > 0 && (
              <Link to="/products" className="btn btn-secondary" style={{ fontSize: "14px", minHeight: "36px" }}>
                View All ({productCount ?? 0})
              </Link>
            )}
          </div>

          {loading ? (
            <div style={{ textAlign: "center", padding: "var(--spacing-2xl) 0", color: "var(--color-muted)" }}>
              Loading catalog products…
            </div>
          ) : latestProducts.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "var(--spacing-3xl) var(--spacing-md)",
                backgroundColor: "var(--color-pearl)",
                borderRadius: "var(--radius-card)",
                border: "1px solid var(--color-hairline)",
              }}
            >
              <h3 style={{ fontSize: "24px", marginBottom: "var(--spacing-sm)" }}>No products yet.</h3>
              <p style={{ color: "var(--color-muted)", marginBottom: "var(--spacing-lg)", maxWidth: "460px", margin: "0 auto var(--spacing-lg) auto" }}>
                Sync your JakMall catalog to automatically discover and import products into your central repository.
              </p>
              <Link to="/sync" className="btn btn-primary">
                Sync JakMall Now
              </Link>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: "var(--spacing-lg)",
              }}
            >
              {latestProducts.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* 4. Editorial Workflow Section (Dark Section) */}
      <section className="section-full section-dark">
        <div className="container" style={{ maxWidth: "900px", textAlign: "center" }}>
          <span style={{ fontSize: "14px", fontWeight: 600, color: "var(--color-blue-on-dark)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            The Architecture
          </span>
          <h2 style={{ fontSize: "var(--font-size-headline)", marginTop: "var(--spacing-sm)", marginBottom: "var(--spacing-md)" }}>
            Engineered for reliability. <br />
            Protected by policy.
          </h2>
          <p style={{ color: "rgba(255, 255, 255, 0.7)", fontSize: "var(--font-size-body)", lineHeight: 1.6, marginBottom: "var(--spacing-xl)" }}>
            Every product discovered from JakMall is parsed into an immutable canonical contract, audited by deterministic policies, and evaluated for marketplace compliance before any draft is generated.
          </p>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: "var(--spacing-lg)",
              textAlign: "left",
            }}
          >
            <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333336" }}>
              <div style={{ color: "var(--color-blue-on-dark)", fontWeight: 600, marginBottom: "4px" }}>1. Discover & Parse</div>
              <p style={{ color: "rgba(255, 255, 255, 0.7)", fontSize: "14px", lineHeight: 1.5 }}>
                Automatic multi-page store crawling with strict anti-loop protection and zero data fabrication.
              </p>
            </div>

            <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333336" }}>
              <div style={{ color: "var(--color-blue-on-dark)", fontWeight: 600, marginBottom: "4px" }}>2. Semantic Pricing</div>
              <p style={{ color: "rgba(255, 255, 255, 0.7)", fontSize: "14px", lineHeight: 1.5 }}>
                Enforces margin protections, rounding rules, and stock truth. Undisclosed stock is never coerced to 0.
              </p>
            </div>

            <div style={{ backgroundColor: "#1e1e20", padding: "var(--spacing-lg)", borderRadius: "var(--radius-card)", border: "1px solid #333336" }}>
              <div style={{ color: "var(--color-blue-on-dark)", fontWeight: 600, marginBottom: "4px" }}>3. Human-in-the-Loop</div>
              <p style={{ color: "rgba(255, 255, 255, 0.7)", fontSize: "14px", lineHeight: 1.5 }}>
                Unverified category suggestions or ambiguous stock require operator review before publication.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
};
