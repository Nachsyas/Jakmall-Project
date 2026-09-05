import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type JobItem } from "../lib/api.js";
import { StatusIndicator } from "../components/StatusIndicator.js";

export const ActivityPage: React.FC = () => {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadJobs() {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getJobs({ limit: 50 });
        if (!cancelled) {
          setJobs(res.jobs);
          setTotal(res.total);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Failed to load activity";
          setError(msg);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadJobs();
    return () => {
      cancelled = true;
    };
  }, []);

  const formatRelativeTime = (isoString: string) => {
    try {
      const date = new Date(isoString);
      const now = new Date();
      const diffSecs = Math.floor((now.getTime() - date.getTime()) / 1000);

      if (diffSecs < 60) return "just now";
      const diffMins = Math.floor(diffSecs / 60);
      if (diffMins < 60) return `${diffMins} ${diffMins === 1 ? "minute" : "minutes"} ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
      const diffDays = Math.floor(diffHours / 24);
      return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
    } catch {
      return isoString;
    }
  };

  return (
    <main className="section-full section-light" style={{ minHeight: "80vh" }}>
      <div className="container" style={{ maxWidth: "860px" }}>
        {/* Header */}
        <div style={{ marginBottom: "var(--spacing-2xl)" }}>
          <span style={{ fontSize: "13px", fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Audit & Execution
          </span>
          <h1 style={{ fontSize: "var(--font-size-headline)", letterSpacing: "-0.02em", marginTop: "4px" }}>
            Activity
          </h1>
          <p style={{ color: "var(--color-muted)", fontSize: "var(--font-size-body)", marginTop: "4px" }}>
            Recent sync jobs and marketplace pipeline actions.
          </p>
        </div>

        {/* Loading State */}
        {loading && (
          <div style={{ textAlign: "center", padding: "var(--spacing-3xl) 0", color: "var(--color-muted)" }}>
            <p>Loading activity log…</p>
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
        {!loading && !error && jobs.length === 0 && (
          <div
            style={{
              textAlign: "center",
              padding: "var(--spacing-3xl) var(--spacing-md)",
              backgroundColor: "var(--color-pearl)",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--color-hairline)",
            }}
          >
            <h3 style={{ fontSize: "22px", marginBottom: "var(--spacing-xs)" }}>No Activity Yet</h3>
            <p style={{ color: "var(--color-muted)", maxWidth: "440px", margin: "0 auto var(--spacing-lg) auto" }}>
              Sync jobs and marketplace operations will be recorded here as they occur.
            </p>
            <Link to="/sync" className="btn btn-primary">
              Sync JakMall Catalog
            </Link>
          </div>
        )}

        {/* Activity Feed */}
        {!loading && !error && jobs.length > 0 && (
          <div>
            <div style={{ fontSize: "14px", color: "var(--color-muted)", marginBottom: "var(--spacing-md)" }}>
              {total} recorded {total === 1 ? "operation" : "operations"}
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}>
              {jobs.map((job) => (
                <div
                  key={job.id}
                  style={{
                    backgroundColor: "var(--color-white)",
                    border: "1px solid var(--color-hairline)",
                    borderRadius: "12px",
                    padding: "var(--spacing-md) var(--spacing-lg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    flexWrap: "wrap",
                    gap: "var(--spacing-md)",
                  }}
                >
                  <div style={{ minWidth: "240px", flexGrow: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-sm)" }}>
                      <span
                        style={{
                          fontSize: "11px",
                          fontFamily: "monospace",
                          fontWeight: 600,
                          backgroundColor: "var(--color-parchment)",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          color: "var(--color-ink)",
                        }}
                      >
                        {job.operation}
                      </span>
                      <span style={{ fontSize: "12px", color: "var(--color-muted)" }}>
                        {formatRelativeTime(job.createdAt)}
                      </span>
                    </div>

                    <div style={{ fontWeight: 600, fontSize: "16px", color: "var(--color-ink)", marginTop: "4px" }}>
                      <Link to={`/products/${encodeURIComponent(job.productId)}`} style={{ color: "var(--color-ink)", textDecoration: "none" }}>
                        {job.productTitle}
                      </Link>
                    </div>

                    {job.errorMessage && (
                      <div style={{ fontSize: "13px", color: "var(--color-danger-text)", marginTop: "2px" }}>
                        Error: {job.errorMessage} {job.errorCode ? `(${job.errorCode})` : ""}
                      </div>
                    )}
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)" }}>
                    <StatusIndicator status={job.status} />
                    <Link
                      to={`/products/${encodeURIComponent(job.productId)}`}
                      style={{ fontSize: "13px", color: "var(--color-action-blue)" }}
                    >
                      View →
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
