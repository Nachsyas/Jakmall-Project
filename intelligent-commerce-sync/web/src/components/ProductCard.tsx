import React from "react";
import { Link } from "react-router-dom";
import type { ProductSummary } from "../lib/api.js";
import { ImageWithFallback } from "./ImageWithFallback.js";
import { StatusIndicator } from "./StatusIndicator.js";

interface ProductCardProps {
  product: ProductSummary;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product }) => {
  const formatPrice = (price: number) => {
    return new Intl.NumberFormat("id-ID", {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(price);
  };

  const renderPrice = () => {
    if (!product.priceRange) {
      return <span style={{ color: "var(--color-muted)" }}>Price not listed</span>;
    }
    if (product.priceRange.min === product.priceRange.max) {
      return formatPrice(product.priceRange.min);
    }
    return `${formatPrice(product.priceRange.min)} – ${formatPrice(product.priceRange.max)}`;
  };

  return (
    <div className="card-utility">
      {/* Product Image Frame */}
      <Link to={`/products/${encodeURIComponent(product.id)}`} style={{ textDecoration: "none" }}>
        <div className="product-image-frame">
          <ImageWithFallback
            src={product.primaryImage}
            alt={product.title}
          />
        </div>
      </Link>

      {/* Product Details */}
      <div style={{ marginTop: "var(--spacing-md)", flexGrow: 1, display: "flex", flexDirection: "column" }}>
        {/* Brand and Status row */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "4px" }}>
          <span style={{ fontSize: "12px", color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 500 }}>
            {product.brand || "JakMall"}
          </span>
          <StatusIndicator status={product.status} />
        </div>

        {/* Title */}
        <Link
          to={`/products/${encodeURIComponent(product.id)}`}
          style={{
            fontSize: "17px",
            fontWeight: 600,
            color: "var(--color-ink)",
            textDecoration: "none",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            lineHeight: 1.3,
            marginBottom: "var(--spacing-sm)",
          }}
        >
          {product.title}
        </Link>

        {/* Price and Variants */}
        <div style={{ marginTop: "auto", paddingTop: "var(--spacing-sm)" }}>
          <div style={{ fontSize: "16px", fontWeight: 600, color: "var(--color-ink)" }}>
            {renderPrice()}
          </div>
          <div style={{ fontSize: "13px", color: "var(--color-muted)", marginTop: "2px" }}>
            {product.variantCount} {product.variantCount === 1 ? "variant" : "variants"}
          </div>
        </div>

        {/* Action Button */}
        <div style={{ marginTop: "var(--spacing-md)" }}>
          <Link
            to={`/products/${encodeURIComponent(product.id)}`}
            className="btn btn-secondary"
            style={{ width: "100%", fontSize: "13px", minHeight: "36px", padding: "6px 14px" }}
          >
            View Details
          </Link>
        </div>
      </div>
    </div>
  );
};
