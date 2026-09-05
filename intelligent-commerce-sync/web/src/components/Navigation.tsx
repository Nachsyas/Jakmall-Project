import React from "react";
import { Link, useLocation } from "react-router-dom";

export const Navigation: React.FC = () => {
  const location = useLocation();

  const getSubnavTitle = () => {
    if (location.pathname === "/") return "Overview";
    if (location.pathname.startsWith("/products/")) return "Product Detail";
    if (location.pathname === "/products") return "Catalog Products";
    if (location.pathname === "/sync") return "Sync JakMall";
    if (location.pathname === "/reviews") return "Operator Reviews";
    if (location.pathname === "/activity") return "Activity Log";
    return "Intelligent Commerce Sync";
  };

  return (
    <header style={{ position: "sticky", top: 0, zIndex: 1000, width: "100%" }}>
      {/* 44px Black Global Navigation */}
      <nav
        aria-label="Global Navigation"
        style={{
          height: "var(--nav-height)",
          backgroundColor: "var(--color-black)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 var(--spacing-lg)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "var(--container-max-width)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: "13px",
            letterSpacing: "-0.01em",
          }}
        >
          {/* Brand Identity */}
          <Link
            to="/"
            style={{
              color: "var(--color-white)",
              fontWeight: 600,
              fontSize: "14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              textDecoration: "none",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                backgroundColor: "var(--color-blue-on-dark)",
              }}
            />
            Intelligent Commerce Sync
          </Link>

          {/* Core Navigation Links */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-xl)",
            }}
          >
            <Link
              to="/products"
              style={{
                color: location.pathname.startsWith("/products")
                  ? "var(--color-white)"
                  : "rgba(255, 255, 255, 0.7)",
                textDecoration: "none",
                transition: "color 0.15s ease",
              }}
            >
              Products
            </Link>
            <Link
              to="/reviews"
              style={{
                color: location.pathname === "/reviews"
                  ? "var(--color-white)"
                  : "rgba(255, 255, 255, 0.7)",
                textDecoration: "none",
                transition: "color 0.15s ease",
              }}
            >
              Reviews
            </Link>
            <Link
              to="/activity"
              style={{
                color: location.pathname === "/activity"
                  ? "var(--color-white)"
                  : "rgba(255, 255, 255, 0.7)",
                textDecoration: "none",
                transition: "color 0.15s ease",
              }}
            >
              Activity
            </Link>
          </div>

          {/* Sync CTA on Global Nav */}
          <div>
            <Link
              to="/sync"
              className="btn btn-primary"
              style={{
                minHeight: "28px",
                padding: "4px 14px",
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              Sync JakMall
            </Link>
          </div>
        </div>
      </nav>

      {/* Sticky Sub-Navigation (52px, blur/saturation backdrop) */}
      <div
        aria-label="Section Sub-Navigation"
        style={{
          height: "var(--subnav-height)",
          backgroundColor: "rgba(245, 245, 247, 0.85)",
          backdropFilter: "saturate(180%) blur(20px)",
          WebkitBackdropFilter: "saturate(180%) blur(20px)",
          borderBottom: "1px solid var(--color-hairline)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "0 var(--spacing-lg)",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "var(--container-max-width)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{
              fontSize: "18px",
              fontWeight: 600,
              color: "var(--color-ink)",
              letterSpacing: "-0.01em",
            }}
          >
            {getSubnavTitle()}
          </span>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-md)", fontSize: "14px" }}>
            <Link
              to="/products"
              style={{
                color: location.pathname === "/products" ? "var(--color-ink)" : "var(--color-muted)",
                fontWeight: location.pathname === "/products" ? 600 : 400,
                textDecoration: "none",
              }}
            >
              All Products
            </Link>
            <span style={{ color: "var(--color-hairline)" }}>|</span>
            <Link
              to="/sync"
              style={{
                color: location.pathname === "/sync" ? "var(--color-ink)" : "var(--color-muted)",
                fontWeight: location.pathname === "/sync" ? 600 : 400,
                textDecoration: "none",
              }}
            >
              Sync Store
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
};
