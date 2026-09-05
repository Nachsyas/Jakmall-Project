import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type ProductSummary } from "../lib/api.js";
import { ProductCard } from "../components/ProductCard.js";

export const ProductsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryParam = searchParams.get("q") || "";

  const [searchInput, setSearchInput] = useState(queryParam);
  const [products, setProducts] = useState<ProductSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const limit = 24;

  useEffect(() => {
    let cancelled = false;

    async function fetchProducts() {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getProducts({
          q: queryParam || undefined,
          limit,
        });

        if (!cancelled) {
          setProducts(res.products);
          setTotal(res.total);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load products";
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchProducts();
    return () => {
      cancelled = true;
    };
  }, [queryParam]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSearchParams({ q: searchInput.trim() });
    } else {
      setSearchParams({});
    }
  };

  return (
    <main className="section-full section-light" style={{ minHeight: "80vh" }}>
      <div className="container">
        {/* Page Header */}
        <div style={{ marginBottom: "var(--spacing-xl)" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Catalog
          </span>
          <h1 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em", marginTop: "4px" }}>
            Products
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-body)", marginTop: "4px" }}>
            Your imported JakMall catalog.
          </p>
        </div>

        {/* Search & Filter Bar */}
        <form
          onSubmit={handleSearchSubmit}
          style={{
            display: "flex",
            gap: "var(--spacing-md)",
            alignItems: "center",
            maxWidth: "600px",
            marginBottom: "var(--spacing-2xl)",
          }}
        >
          <div style={{ position: "relative", flexGrow: 1 }}>
            <input
              type="text"
              placeholder="Search products by title or brand…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{
                width: "100%",
                height: "44px",
                padding: "0 16px",
                fontSize: "15px",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-pill)",
                backgroundColor: "var(--color-parchment)",
                outline: "none",
                fontFamily: "var(--font-system)",
                transition: "border-color 0.15s ease, background-color 0.15s ease",
              }}
              onFocus={(e) => {
                e.target.style.borderColor = "var(--color-focus-blue)";
                e.target.style.backgroundColor = "var(--color-white)";
              }}
              onBlur={(e) => {
                e.target.style.borderColor = "var(--color-hairline)";
                e.target.style.backgroundColor = "var(--color-parchment)";
              }}
            />
          </div>
          <button type="submit" className="btn btn-primary" style={{ minHeight: "44px", padding: "0 22px" }}>
            Search
          </button>
          {queryParam && (
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => {
                setSearchInput("");
                setSearchParams({});
              }}
            >
              Clear
            </button>
          )}
        </form>

        {/* Error State */}
        {error && (
          <div
            style={{
              backgroundColor: "#fff0f0",
              border: "1px solid #ffcccc",
              borderRadius: "var(--radius-card)",
              padding: "var(--spacing-xl)",
              textAlign: "center",
              marginBottom: "var(--spacing-xl)",
            }}
          >
            <h3 style={{ fontSize: "20px", color: "var(--color-danger-text)", marginBottom: "var(--spacing-sm)" }}>
              Unable to reach the local API
            </h3>
            <p style={{ color: "var(--color-ink)", marginBottom: "var(--spacing-md)" }}>
              {error}
            </p>
            <p style={{ fontSize: "14px", color: "var(--color-muted)", marginBottom: "var(--spacing-lg)" }}>
              Make sure the API server is running on <strong>http://localhost:3001</strong> via <code>npm run dev:api</code>.
            </p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => window.location.reload()}
            >
              Retry Connection
            </button>
          </div>
        )}

        {/* Loading State */}
        {loading && !error && (
          <div style={{ textAlign: "center", padding: "var(--spacing-3xl) 0", color: "var(--color-muted)" }}>
            <p style={{ fontSize: "17px" }}>Loading catalog products…</p>
          </div>
        )}

        {/* Empty State */}
        {!loading && !error && products.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--spacing-3xl) var(--spacing-md)",
              backgroundColor: "var(--color-pearl)",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-hairline)",
            }}
          >
            <h3 style={{ fontSize: "24px", marginBottom: "var(--spacing-sm)" }}>
              {queryParam ? "No matching products found." : "No products yet."}
            </h3>
            <p style={{ color: "var(--color-muted)", marginBottom: "var(--spacing-lg)", maxWidth: "480px", margin: "0 auto var(--spacing-lg) auto" }}>
              {queryParam
                ? `No products found matching "${queryParam}". Try clearing your search or checking other keywords.`
                : "Sync your JakMall catalog to get started. Discovered products will appear here immediately."}
            </p>
            {queryParam ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setSearchInput("");
                  setSearchParams({});
                }}
              >
                Clear Search
              </button>
            ) : (
              <Link to="/sync" className="btn btn-primary">
                Sync JakMall Now
              </Link>
            )}
          </div>
        )}

        {/* Product Grid: 4 cols wide desktop, 3 small desktop, 2 tablet, 1 phone */}
        {!loading && !error && products.length > 0 && (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "var(--spacing-md)",
                fontSize: "14px",
                color: "var(--color-muted)",
              }}
            >
              <span>
                Showing {products.length} of {total} {total === 1 ? "product" : "products"}
              </span>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: "var(--spacing-lg)",
              }}
            >
              {products.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
};
