import { describe, expect, test } from "bun:test";
import {
  computePhase,
  estimatePLongAfter,
  formatCountdown,
  impliedReturn,
  inFinalWindow,
  nearBound,
  ratioToReturn,
} from "./logic";

const E18 = 10n ** 18n;

describe("round phases", () => {
  test("walks through the lifecycle", () => {
    expect(computePhase(1, 99, 100, 200)).toBe("trading");
    expect(computePhase(1, 100, 100, 200)).toBe("closed");
    expect(computePhase(2, 150, 100, 200)).toBe("evaluating");
    expect(computePhase(2, 200, 100, 200)).toBe("awaiting-settlement");
    expect(computePhase(3, 999, 100, 200)).toBe("settled");
    expect(computePhase(4, 999, 100, 200)).toBe("cancelled");
    expect(computePhase(0, 0, 0, 0)).toBe("none");
  });

  test("final window", () => {
    expect(inFinalWindow(90, 100, 20)).toBe(true);
    expect(inFinalWindow(79, 100, 20)).toBe(false);
    expect(inFinalWindow(100, 100, 20)).toBe(false);
  });
});

describe("returns", () => {
  test("ratio to return", () => {
    expect(ratioToReturn(1_034n * 10n ** 15n)).toBeCloseTo(0.034, 6);
    expect(ratioToReturn(E18)).toBe(0);
  });

  test("implied return = rMin + pLong x (rMax - rMin)", () => {
    const rMin = 9n * 10n ** 17n; // 0.9
    const rMax = 11n * 10n ** 17n; // 1.1
    expect(impliedReturn(E18 / 2n, rMin, rMax)).toBeCloseTo(0, 9);
    expect(impliedReturn(75n * 10n ** 16n, rMin, rMax)).toBeCloseTo(0.05, 9);
  });
});

describe("bounds and countdown", () => {
  test("warns near 0.01 / 0.99", () => {
    expect(nearBound(0.5)).toBe(false);
    expect(nearBound(0.97)).toBe(true);
    expect(nearBound(0.025)).toBe(true);
  });

  test("countdown", () => {
    expect(formatCountdown(3725)).toBe("1h 02m 05s");
    expect(formatCountdown(65)).toBe("1m 05s");
    expect(formatCountdown(-4)).toBe("0s");
  });
});

describe("pLong after", () => {
  const base = { pLong: 0.5, seedCredits: 5 };

  test("buying LONG raises pLong, buying SHORT lowers it", () => {
    const up = estimatePLongAfter({ ...base, action: "buy", side: "LONG", legOutCredits: 0.5 });
    const down = estimatePLongAfter({ ...base, action: "buy", side: "SHORT", legOutCredits: 0.5 });
    expect(up).toBeGreaterThan(0.5);
    expect(down).toBeLessThan(0.5);
    expect(up + down).toBeCloseTo(1, 6);
  });

  test("selling LONG lowers pLong", () => {
    const after = estimatePLongAfter({ ...base, action: "sell", side: "LONG", legOutCredits: 0.4 });
    expect(after).toBeLessThan(0.5);
  });

  test("clamps to the 0.01 / 0.99 bounds", () => {
    expect(estimatePLongAfter({ ...base, action: "buy", side: "LONG", legOutCredits: 1000 })).toBe(0.99);
    expect(estimatePLongAfter({ ...base, action: "buy", side: "SHORT", legOutCredits: 1000 })).toBe(0.01);
  });
});
