import React from "react";
import { Link } from "react-router-dom";

export const Footer: React.FC = () => {
  return (
    <footer
      style={{
        backgroundColor: "var(--color-parchment)",
        borderTop: "1px solid var(--color-hairline)",
        padding: "var(--spacing-xl) var(--spacing-lg)",
        marginTop: "auto",
        fontSize: "12px",
        color: "var(--color-muted)",
      }}
    >
      <div
        className="container"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "var(--spacing-md)",
        }}
      >
        <div>
          <p style={{ fontWeight: 500, color: "var(--color-ink)", marginBottom: "4px" }}>
            Intelligent Commerce Sync
          </p>
          <p>
            Controlled JakMall to Shopee catalog pipeline. Read-only preparation & review boundaries.
          </p>
        </div>

        <div style={{ display: "flex", gap: "var(--spacing-lg)" }}>
          <Link to="/" style={{ color: "var(--color-muted)" }}>Overview</Link>
          <Link to="/products" style={{ color: "var(--color-muted)" }}>Catalog</Link>
          <Link to="/reviews" style={{ color: "var(--color-muted)" }}>Reviews</Link>
          <Link to="/activity" style={{ color: "var(--color-muted)" }}>Activity</Link>
          <Link to="/sync" style={{ color: "var(--color-muted)" }}>Sync JakMall</Link>
        </div>
      </div>
    </footer>
  );
};
