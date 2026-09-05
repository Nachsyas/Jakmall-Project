import React from "react";

export type StatusType = "READY" | "NEEDS_REVIEW" | "BLOCKED" | "PENDING" | "IMPORTED" | "COMPLETED" | "FAILED" | string;

interface StatusIndicatorProps {
  status: StatusType;
  label?: string;
  className?: string;
}

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, label, className = "" }) => {
  const norm = (status || "").toUpperCase();

  let symbol = "○";
  let colorClass = "pending";
  let displayLabel = label || status;

  if (norm === "READY" || norm === "COMPLETED" || norm === "RESOLVED" || norm === "APPROVED") {
    symbol = "✓";
    colorClass = "ready";
    displayLabel = label || "Ready";
  } else if (norm === "NEEDS_REVIEW" || norm === "REVIEW_REQUIRED") {
    symbol = "!";
    colorClass = "needs-review";
    displayLabel = label || "Needs Review";
  } else if (norm === "BLOCKED" || norm === "FAILED" || norm === "REJECTED") {
    symbol = "×";
    colorClass = "blocked";
    displayLabel = label || "Blocked";
  } else if (norm === "IMPORTED") {
    symbol = "○";
    colorClass = "pending";
    displayLabel = label || "Imported";
  } else if (norm === "PENDING" || norm === "PROCESSING") {
    symbol = "○";
    colorClass = "pending";
    displayLabel = label || "Pending";
  }

  return (
    <span className={`status-indicator ${colorClass} ${className}`} title={norm}>
      <span aria-hidden="true" style={{ fontWeight: 700, fontFamily: "monospace" }}>
        {symbol}
      </span>
      <span>{displayLabel}</span>
    </span>
  );
};
