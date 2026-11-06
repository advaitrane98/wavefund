"use client";

import { useState } from "react";

/** Long text clamped to a few lines, with a toggle. Used for on-chain rationales. */
export function ClampedText({
  text,
  lines = 3,
  className = "",
}: Readonly<{ text: string; lines?: 2 | 3 | 4; className?: string }>) {
  const [open, setOpen] = useState(false);
  const clampClass = lines === 2 ? "line-clamp-2" : lines === 4 ? "line-clamp-4" : "line-clamp-3";
  const long = text.length > lines * 55;
  return (
    <div className={className}>
      <p className={`whitespace-pre-line break-words text-sm text-muted ${open ? "" : clampClass}`}>{text}</p>
      {long ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="eyebrow mt-1 min-h-6 text-faint hover:text-text"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}
