import { describe, expect, test } from "bun:test";
import { applySlippage, credits, long, usdc, wave } from "./units";

describe("units", () => {
  test("USDC uses 6 decimals", () => {
    expect(usdc.format(1_234_567_890n)).toBe("1,234.56");
    expect(usdc.parse("1.5")).toBe(1_500_000n);
  });

  test("credits use 6 decimals and LONG/WAVE use 18", () => {
    expect(credits.format(5_000_000n)).toBe("5.00");
    expect(long.format(10n ** 18n + 5n * 10n ** 14n)).toBe("1.0005");
    expect(wave.parse("2")).toBe(2n * 10n ** 18n);
  });

  test("rejects bad input and too many decimals", () => {
    expect(usdc.parse("abc")).toBeNull();
    expect(usdc.parse("")).toBeNull();
    expect(usdc.parse("1.1234567")).toBeNull();
    expect(usdc.parse("-1")).toBeNull();
  });

  test("formats negatives and truncates instead of rounding", () => {
    expect(usdc.format(-1_999_999n)).toBe("-1.99");
  });

  test("0.5% slippage", () => {
    expect(applySlippage(1_000_000n)).toBe(995_000n);
  });
});
