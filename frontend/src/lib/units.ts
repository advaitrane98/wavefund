import { formatUnits, parseUnits } from "viem";

/**
 * One helper per unit, so a raw integer is never shown with the wrong decimals.
 * USDC 6, credits 6, LONG / SHORT / WAVE / tETH 18.
 * One credit = one complete set = 1e12 raw LONG plus 1e12 raw SHORT.
 */
export interface Unit {
  readonly symbol: string;
  readonly decimals: number;
  /** Format a raw amount for display (truncated, not rounded, with thousands separators). */
  format: (raw: bigint, digits?: number) => string;
  /** Parse user text into a raw amount, or null when it is not a valid non-negative number. */
  parse: (text: string) => bigint | null;
}

function groupInteger(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function makeUnit(symbol: string, decimals: number, defaultDigits: number): Unit {
  return {
    symbol,
    decimals,
    format(raw, digits = defaultDigits) {
      const negative = raw < 0n;
      const text = formatUnits(negative ? -raw : raw, decimals);
      const [int, frac = ""] = text.split(".");
      const shown = frac.slice(0, digits).padEnd(digits, "0");
      const body = digits > 0 ? `${groupInteger(int)}.${shown}` : groupInteger(int);
      return negative ? `-${body}` : body;
    },
    parse(text) {
      const clean = text.trim();
      if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") return null;
      const [int, frac = ""] = clean.split(".");
      if (frac.length > decimals) return null;
      try {
        return parseUnits(`${int || "0"}.${frac || "0"}`, decimals);
      } catch {
        return null;
      }
    },
  };
}

export const usdc = makeUnit("USDC", 6, 2);
export const credits = makeUnit("credits", 6, 2);
export const long = makeUnit("LONG", 18, 4);
export const short = makeUnit("SHORT", 18, 4);
export const wave = makeUnit("WAVE", 18, 4);
export const teth = makeUnit("tETH", 18, 4);

/** Raw LONG (or SHORT) units that one credit mints. */
export const COMPLETE_SET_SCALE = 10n ** 12n;
export const ONE_E18 = 10n ** 18n;
export const BPS = 10_000n;

/** A 1e18 fixed-point value as a plain number (for display and charts only). */
export const fixedToNumber = (x: bigint): number => Number(x) / 1e18;

/** 1e18 probability as a percentage string, e.g. 0.5e18 -> "50.0%". */
export const formatProbability = (x: bigint, digits = 1): string =>
  `${(fixedToNumber(x) * 100).toFixed(digits)}%`;

/** Signed percent string from a plain fraction, e.g. 0.0312 -> "+3.12%". */
export const formatSignedPercent = (fraction: number, digits = 2): string => {
  const v = fraction * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
};

/** Basis points as a percent, e.g. 6000n -> "60.0%". */
export const formatBps = (bps: bigint | number, digits = 1): string =>
  `${(Number(bps) / 100).toFixed(digits)}%`;

/** Apply a slippage tolerance (in bps) to an expected output. */
export const applySlippage = (expected: bigint, slippageBps = 50n): bigint =>
  (expected * (BPS - slippageBps)) / BPS;
