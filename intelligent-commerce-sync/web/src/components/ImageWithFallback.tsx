import React, { useState } from "react";

interface ImageWithFallbackProps {
  src: string | null | undefined;
  alt: string;
  loading?: "lazy" | "eager";
  style?: React.CSSProperties;
  className?: string;
}

export const ImageWithFallback: React.FC<ImageWithFallbackProps> = ({
  src,
  alt,
  loading = "lazy",
  style,
  className = "",
}) => {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  if (!src || error) {
    return (
      <div className={`product-image-fallback ${className}`} style={style} role="img" aria-label={alt}>
        <span>No image available</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      onLoad={() => setLoaded(true)}
      onError={() => setError(true)}
      className={className}
      style={{
        opacity: loaded ? 1 : 0.8,
        transition: "opacity 0.2s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)",
        ...style,
      }}
    />
  );
};
