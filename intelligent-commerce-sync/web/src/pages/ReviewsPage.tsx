import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ReviewItem } from "../lib/api.js";
import { StatusIndicator } from "../components/StatusIndicator.js";

export const ReviewsPage: React.FC = () => {
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadReviews() {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getReviews({ limit: 50 });
        if (!cancelled) {
          setReviews(res.reviews);
          setTotal(res.total);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load reviews";
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadReviews();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="section-full section-light" style={{ minHeight: "80vh" }}>
      <div className="container" style={{ maxWidth: "860px" }}>
        {/* Header */}
        <div style={{ marginBottom: "var(--spacing-2xl)" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Operator Queue
          </span>
          <h1 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em", marginTop: "4px" }}>
            Reviews
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-body)", marginTop: "4px" }}>
            Products and sync jobs requiring human review before marketplace publication.
          </p>
        </div>

        {/* Loading State */}
        {loading && (
          <div style={{ textAlign: "center", padding: "var(--spacing-3xl) 0", color: "var(--color-muted)" }}>
            <p>Loading operator reviews…</p>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div
            style={{
              backgroundColor: "#fff0f0",
              border: "1px solid #ffcccc",
              borderRadius: "var(--radius-card)",
              padding: "var(--spacing-lg)",
              marginBottom: "var(--spacing-xl)",
              color: "var(--color-danger-text)",
            }}
          >
            <strong>Error:</strong> {error}
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && reviews.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--spacing-3xl) var(--spacing-md)",
              backgroundColor: "var(--color-pearl)",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-hairline)",
            }}
          >
            <div style={{ fontSize: "36px", marginBottom: "var(--spacing-sm)" }}>✓</div>
            <h3 style={{ fontSize: "22px", marginBottom: "var(--spacing-xs)" }}>All Clear</h3>
            <p style={{ color: "var(--color-muted)", maxWidth: "440px", margin: "0 auto var(--spacing-lg) auto" }}>
              There are currently no products or sync operations in the review queue.
            </p>
            <Link to="/products" className="btn btn-secondary">
              Browse Products
            </Link>
          </div>
        )}

        {/* Editorial Review List */}
        {!loading && !error && reviews.length > 0 && (
          <div>
            <div style={{ fontSize: "14px", color: "var(--color-muted)", marginBottom: "var(--spacing-md)" }}>
              {total} {total === 1 ? "item requires" : "items require"} attention
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
              {reviews.map((item) => (
                <div
                  key={item.jobId}
                  style={{
                    backgroundColor: "var(--color-white)",
                    border: "1px solid var(--color-hairline)",
                    borderRadius: "var(--radius-card)",
                    padding: "var(--spacing-xl)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--spacing-md)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "var(--spacing-sm)" }}>
                    <div>
                      <div style={{ fontSize: "13px", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
                        {item.sourceProductId ? `JakMall #${item.sourceProductId}` : "Product"}
                      </div>
                      <h2 style={{ fontSize: "22px", color: "var(--color-ink)", marginTop: "2px" }}>
                        {item.productTitle}
                      </h2>
                    </div>
                    <StatusIndicator status={item.status} label={item.status === "NEEDS_REVIEW" ? "Needs Review" : item.status} />
                  </div>

                  {/* Reason Callout */}
                  <div
                    style={{
                      padding: "10px 14px",
                      borderRadius: "8px",
                      backgroundColor: item.status === "BLOCKED" ? "rgba(215, 0, 21, 0.08)" : "rgba(178, 94, 2, 0.08)",
                      border: `1px solid ${item.status === "BLOCKED" ? "rgba(215, 0, 21, 0.2)" : "rgba(178, 94, 2, 0.2)"}`,
                      fontSize: "14px",
                      color: "var(--color-ink)",
                    }}
                  >
                    <strong>Reason:</strong> {item.reason || "Review required by policy gating"}
                  </div>

                  {/* Status Grid */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                      gap: "var(--spacing-md)",
                      fontSize: "14px",
                      padding: "var(--spacing-md) 0",
                      borderTop: "1px solid var(--color-hairline)",
                      borderBottom: "1px solid var(--color-hairline)",
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--color-muted)", fontSize: "12px", textTransform: "uppercase" }}>Category State</div>
                      <div style={{ fontWeight: 500, marginTop: "2px" }}>{item.categoryStatus || "Pending"}</div>
                    </div>
                    <div>
                      <div style={{ color: "var(--color-muted)", fontSize: "12px", textTransform: "uppercase" }}>Stock State</div>
                      <div style={{ fontWeight: 500, marginTop: "2px" }}>{item.stockStatus || "Resolved"}</div>
                    </div>
                    <div>
                      <div style={{ color: "var(--color-muted)", fontSize: "12px", textTransform: "uppercase" }}>Assessed Risk</div>
                      <div style={{ fontWeight: 500, marginTop: "2px" }}>{item.risk || "LOW"}</div>
                    </div>
                  </div>

                  {/* Issues */}
                  {((item.blockers && item.blockers.length > 0) || (item.warnings && item.warnings.length > 0)) && (
                    <div style={{ fontSize: "13px" }}>
                      {item.blockers?.map((b, i) => (
                        <div key={i} style={{ color: "var(--color-danger-text)", marginBottom: "2px" }}>
                          × Blocker: {b}
                        </div>
                      ))}
                      {item.warnings?.map((w, i) => (
                        <div key={i} style={{ color: "var(--color-warning-text)", marginBottom: "2px" }}>
                          ! Warning: {w}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Action Link */}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--spacing-xs)" }}>
                    <Link
                      to={`/products/${encodeURIComponent(item.productId)}`}
                      className="btn btn-secondary"
                      style={{ fontSize: "13px", minHeight: "36px" }}
                    >
                      View Product & Prepare Draft →
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
};
