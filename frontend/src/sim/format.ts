export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function fmtUsdc(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtTok(n: number, digits = 4): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 0.0312 -> "3.12%" */
export function fmtPct(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 0.0312 -> "+3.12%" */
export function fmtSignedPct(fraction: number, digits = 2): string {
  const v = fraction * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtSigned(n: number, digits = 2): string {
  return `${n > 0 ? "+" : ""}${fmtUsdc(n, digits)}`;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const roundLabel = (id: number): string => `#${String(id).padStart(3, "0")}`;
