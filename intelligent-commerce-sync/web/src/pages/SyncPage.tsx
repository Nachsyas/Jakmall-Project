import React, { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, type CatalogDiscoverResponse, type CatalogImportResponse } from "../lib/api.js";

const DEFAULT_STORE_URL = "https://www.jakmall.com/acmic-official-store";
const DEFAULT_STORE_NAME = "ACMIC Official Store";

type SyncStep = "IDLE" | "DISCOVERING" | "DISCOVERED" | "IMPORTING" | "COMPLETED" | "ERROR";

export const SyncPage: React.FC = () => {
  const [storeUrl, setStoreUrl] = useState(DEFAULT_STORE_URL);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [maxProducts, setMaxProducts] = useState(20);
  const [maxPages, setMaxPages] = useState(2);

  const [step, setStep] = useState<SyncStep>("IDLE");
  const [discoverResult, setDiscoverResult] = useState<CatalogDiscoverResponse | null>(null);
  const [importResult, setImportResult] = useState<CatalogImportResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isSyncingRef = useRef(false);
  const isBusy = step === "DISCOVERING" || step === "IMPORTING";

  // Sanitize parameters strictly within backend API bounds [1..50] products and [1..5] pages
  const getSanitizedOptions = () => {
    return {
      url: storeUrl.trim() || DEFAULT_STORE_URL,
      maxProducts: Math.max(1, Math.min(50, Math.floor(Number(maxProducts) || 20))),
      maxPages: Math.max(1, Math.min(5, Math.floor(Number(maxPages) || 2))),
      persist: true,
    };
  };

  // One-Click "Sync Now" workflow: Discovers, then automatically imports
  const handleSyncNow = async () => {
    if (isSyncingRef.current || isBusy) return;
    isSyncingRef.current = true;

    setErrorMessage(null);
    setDiscoverResult(null);
    setImportResult(null);
    setStep("DISCOVERING");

    const opts = getSanitizedOptions();

    try {
      // 1. Discovery phase
      const discoverRes = await api.discoverCatalog({
        url: opts.url,
        maxProducts: opts.maxProducts,
        maxPages: opts.maxPages,
      });
      setDiscoverResult(discoverRes);

      if (discoverRes.discoveredCount === 0) {
        setStep("DISCOVERED");
        return;
      }

      // 2. Automatically trigger import
      setStep("IMPORTING");
      const importRes = await api.importCatalog({
        url: opts.url,
        maxProducts: opts.maxProducts,
        maxPages: opts.maxPages,
        persist: opts.persist,
      });
      setImportResult(importRes);
      setStep("COMPLETED");
    } catch (err: unknown) {
      setStep("ERROR");
      const msg = err instanceof Error ? err.message : "Sync operation encountered an error";
      setErrorMessage(msg);
    } finally {
      isSyncingRef.current = false;
    }
  };

  // Preview only workflow
  const handlePreviewOnly = async () => {
    if (isSyncingRef.current || isBusy) return;
    isSyncingRef.current = true;

    setErrorMessage(null);
    setDiscoverResult(null);
    setImportResult(null);
    setStep("DISCOVERING");

    const opts = getSanitizedOptions();

    try {
      const discoverRes = await api.discoverCatalog({
        url: opts.url,
        maxProducts: opts.maxProducts,
        maxPages: opts.maxPages,
      });
      setDiscoverResult(discoverRes);
      setStep("DISCOVERED");
    } catch (err: unknown) {
      setStep("ERROR");
      const msg = err instanceof Error ? err.message : "Discovery encountered an error";
      setErrorMessage(msg);
    } finally {
      isSyncingRef.current = false;
    }
  };

  // Import after preview
  const handleImportDiscovered = async () => {
    if (isSyncingRef.current || isBusy) return;
    isSyncingRef.current = true;

    setErrorMessage(null);
    setStep("IMPORTING");

    const opts = getSanitizedOptions();

    try {
      const importRes = await api.importCatalog({
        url: opts.url,
        maxProducts: opts.maxProducts,
        maxPages: opts.maxPages,
        persist: opts.persist,
      });
      setImportResult(importRes);
      setStep("COMPLETED");
    } catch (err: unknown) {
      setStep("ERROR");
      const msg = err instanceof Error ? err.message : "Import encountered an error";
      setErrorMessage(msg);
    } finally {
      isSyncingRef.current = false;
    }
  };

  return (
    <main className="section-full section-light" style={{ minHeight: "80vh" }}>
      <div className="container" style={{ maxWidth: "760px" }}>
        {/* Header */}
        <div style={{ marginBottom: "var(--spacing-2xl)", textAlign: "center" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-action-blue)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Automated Catalog Pipeline
          </span>
          <h1 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em", marginTop: "4px" }}>
            Sync JakMall
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-body)", marginTop: "6px", lineHeight: 1.5 }}>
            Discover and import catalog products from your configured JakMall store into your local synchronized database.
          </p>
        </div>

        {/* Sync Card */}
        <div
          style={{
            backgroundColor: "var(--color-white)",
            border: "1px solid var(--color-hairline)",
            borderRadius: "var(--radius-card)",
            padding: "var(--spacing-2xl)",
            marginBottom: "var(--spacing-xl)",
          }}
        >
          {/* Current Source Badge */}
          <div style={{ marginBottom: "var(--spacing-xl)" }}>
            <div style={{ fontSize: "12px", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>
              Configured Catalog Source
            </div>
            <div style={{ fontSize: "20px", fontWeight: 600, color: "var(--color-ink)", marginTop: "2px" }}>
              {storeUrl === DEFAULT_STORE_URL ? DEFAULT_STORE_NAME : storeUrl}
            </div>
            <div style={{ fontSize: "13px", color: "var(--color-muted)", marginTop: "4px", wordBreak: "break-all" }}>
              {storeUrl}
            </div>
          </div>

          {/* Action Buttons */}
          <div style={{ display: "flex", gap: "var(--spacing-md)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--spacing-lg)" }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSyncNow}
              disabled={isBusy}
              style={{ fontSize: "16px", minHeight: "48px", padding: "12px 32px" }}
            >
              {isBusy ? (step === "DISCOVERING" ? "Scanning Catalog…" : "Importing Products…") : "Sync Now"}
            </button>

            <button
              type="button"
              className="btn btn-secondary"
              onClick={handlePreviewOnly}
              disabled={isBusy}
              style={{ fontSize: "15px", minHeight: "48px", padding: "12px 20px" }}
            >
              Preview Discovery
            </button>

            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                marginLeft: "auto",
                background: "none",
                border: "none",
                color: "var(--color-action-blue)",
                fontSize: "14px",
                cursor: "pointer",
                padding: "8px",
              }}
            >
              {showAdvanced ? "Hide settings" : "Change source ▾"}
            </button>
          </div>

          {/* Optional Advanced Disclosure */}
          {showAdvanced && (
            <div
              style={{
                marginTop: "var(--spacing-lg)",
                paddingTop: "var(--spacing-lg)",
                borderTop: "1px solid var(--color-hairline)",
              }}
            >
              <div style={{ marginBottom: "var(--spacing-md)" }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "4px" }}>
                  Store Catalog URL
                </label>
                <input
                  type="text"
                  value={storeUrl}
                  onChange={(e) => setStoreUrl(e.target.value)}
                  disabled={isBusy}
                  style={{
                    width: "100%",
                    height: "40px",
                    padding: "0 12px",
                    fontSize: "14px",
                    border: "1px solid var(--color-hairline)",
                    borderRadius: "8px",
                    backgroundColor: "var(--color-pearl)",
                  }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)" }}>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "4px" }}>
                    Max Products Limit (1–50)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxProducts}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setMaxProducts(isNaN(val) ? 10 : Math.max(1, Math.min(50, val)));
                    }}
                    disabled={isBusy}
                    style={{
                      width: "100%",
                      height: "40px",
                      padding: "0 12px",
                      fontSize: "14px",
                      border: "1px solid var(--color-hairline)",
                      borderRadius: "8px",
                      backgroundColor: "var(--color-pearl)",
                    }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "4px" }}>
                    Max Pages Limit (1–5)
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={maxPages}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      setMaxPages(isNaN(val) ? 1 : Math.max(1, Math.min(5, val)));
                    }}
                    disabled={isBusy}
                    style={{
                      width: "100%",
                      height: "40px",
                      padding: "0 12px",
                      fontSize: "14px",
                      border: "1px solid var(--color-hairline)",
                      borderRadius: "8px",
                      backgroundColor: "var(--color-pearl)",
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Indeterminate Loading Indicator */}
          {isBusy && (
            <div
              style={{
                marginTop: "var(--spacing-xl)",
                padding: "var(--spacing-lg)",
                backgroundColor: "var(--color-parchment)",
                borderRadius: "var(--radius-card)",
                textAlign: "center",
              }}
              aria-live="polite"
            >
              <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-ink)", marginBottom: "4px" }}>
                {step === "DISCOVERING" ? "Scanning catalog store pages…" : "Importing and persisting products…"}
              </div>
              <p style={{ fontSize: "13px", color: "var(--color-muted)" }}>
                Fetching live HTML from JakMall, resolving product links, and parsing canonical schemas. Please wait…
              </p>
            </div>
          )}

          {/* Error Message */}
          {step === "ERROR" && errorMessage && (
            <div
              style={{
                marginTop: "var(--spacing-xl)",
                padding: "var(--spacing-lg)",
                backgroundColor: "#fff0f0",
                border: "1px solid #ffcccc",
                borderRadius: "var(--radius-card)",
                color: "var(--color-danger-text)",
              }}
            >
              <strong>Sync Error:</strong> {errorMessage}
            </div>
          )}

          {/* Preview Discovery State */}
          {step === "DISCOVERED" && discoverResult && (
            <div
              style={{
                marginTop: "var(--spacing-xl)",
                padding: "var(--spacing-lg)",
                backgroundColor: "var(--color-pearl)",
                border: "1px solid var(--color-hairline)",
                borderRadius: "var(--radius-card)",
              }}
            >
              <h3 style={{ fontSize: "18px", marginBottom: "var(--spacing-sm)" }}>Discovery Preview</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--spacing-md)", marginBottom: "var(--spacing-md)", fontSize: "14px" }}>
                <div>Pages Scanned: <strong>{discoverResult.pagesScanned}</strong></div>
                <div>Products Discovered: <strong>{discoverResult.discoveredCount}</strong></div>
              </div>

              {discoverResult.discoveredCount > 0 ? (
                <div>
                  <div style={{ maxHeight: "150px", overflowY: "auto", fontSize: "12px", fontFamily: "monospace", color: "var(--color-muted)", backgroundColor: "var(--color-white)", padding: "8px", borderRadius: "6px", border: "1px solid var(--color-hairline)", marginBottom: "var(--spacing-md)" }}>
                    {discoverResult.discoveredUrls.map((u, i) => (
                      <div key={i} style={{ marginBottom: "2px" }}>
                        {i + 1}. {u.titleHint || u.url}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={handleImportDiscovered}
                    disabled={isBusy}
                  >
                    {isBusy ? "Importing Products…" : `Import Discovered Products (${discoverResult.discoveredCount})`}
                  </button>
                </div>
              ) : (
                <p style={{ fontSize: "14px", color: "var(--color-muted)" }}>
                  Zero products discovered on the scanned pages.
                </p>
              )}
            </div>
          )}

          {/* Completed State with Real Counts */}
          {step === "COMPLETED" && importResult && (
            <div
              style={{
                marginTop: "var(--spacing-xl)",
                padding: "var(--spacing-xl)",
                backgroundColor: "rgba(29, 124, 57, 0.05)",
                border: "1px solid rgba(29, 124, 57, 0.3)",
                borderRadius: "var(--radius-card)",
              }}
            >
              <div style={{ fontSize: "14px", color: "var(--color-success-text)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                ✓ Sync Completed
              </div>
              <h3 style={{ fontSize: "22px", color: "var(--color-ink)", marginTop: "2px", marginBottom: "var(--spacing-md)" }}>
                Catalog Import Summary
              </h3>

              {/* Real Metric Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: "var(--spacing-md)",
                  textAlign: "center",
                  padding: "var(--spacing-md) 0",
                  borderTop: "1px solid rgba(29, 124, 57, 0.2)",
                  borderBottom: "1px solid rgba(29, 124, 57, 0.2)",
                  marginBottom: "var(--spacing-lg)",
                }}
              >
                <div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)" }}>
                    {importResult.pagesScanned}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-muted)" }}>Pages Scanned</div>
                </div>
                <div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-ink)" }}>
                    {importResult.discoveredCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-muted)" }}>Discovered</div>
                </div>
                <div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: "var(--color-success-text)" }}>
                    {importResult.importedCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-muted)" }}>Imported</div>
                </div>
                <div>
                  <div style={{ fontSize: "24px", fontWeight: 700, color: importResult.failedCount > 0 ? "var(--color-danger-text)" : "var(--color-ink)" }}>
                    {importResult.failedCount}
                  </div>
                  <div style={{ fontSize: "12px", color: "var(--color-muted)" }}>Failed</div>
                </div>
              </div>

              {/* Failures list if any */}
              {importResult.failures && importResult.failures.length > 0 && (
                <div style={{ marginBottom: "var(--spacing-lg)", fontSize: "13px", color: "var(--color-danger-text)" }}>
                  <strong>Failed Items ({importResult.failures.length}):</strong>
                  <ul style={{ paddingLeft: "20px", marginTop: "4px" }}>
                    {importResult.failures.map((f, i) => (
                      <li key={i}>
                        {f.url}: {f.error} ({f.code})
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Post-Import Links */}
              <div style={{ display: "flex", gap: "var(--spacing-md)" }}>
                <Link to="/products" className="btn btn-primary">
                  View Catalog Products →
                </Link>
                <Link to="/activity" className="btn btn-secondary">
                  View Activity Log
                </Link>
              </div>
            </div>
          )}
        </div>

        {/* Scope disclaimer */}
        <div style={{ fontSize: "13px", color: "var(--color-muted)", lineHeight: 1.5, textAlign: "center" }}>
          <p>
            * Catalog synchronization queries public store pages and imports all discovered products
            from the configured store subject to safety limits and pagination boundaries.
          </p>
        </div>
      </div>
    </main>
  );
};
