import { describe, expect, it } from "vitest";

import { buildLineChart } from "./chart.js";

describe("buildLineChart", () => {
  it("draws one path through an unbroken series", () => {
    const chart = buildLineChart([100, 200, 300], 200, 100, 0);
    expect(chart.paths).toEqual(["M0 66.7 L100 33.3 L200 0"]);
    expect(chart.dots).toHaveLength(3);
  });

  it("splits at a null so the gap shows", () => {
    const chart = buildLineChart([100, 100, null, 100, 100], 400, 100, 0);
    expect(chart.paths).toHaveLength(2);
    expect(chart.paths[0]).toBe("M0 0 L100 0");
    expect(chart.paths[1]).toBe("M300 0 L400 0");
  });

  it("keeps an isolated point as a dot with no path", () => {
    const chart = buildLineChart([null, 50, null], 100, 100, 0);
    expect(chart.paths).toEqual([]);
    expect(chart.dots).toEqual([{ x: 50, y: 0, index: 1 }]);
  });

  it("handles empty and all-null series", () => {
    expect(buildLineChart([], 100, 100, 0).paths).toEqual([]);
    const allNull = buildLineChart([null, null], 100, 100, 0);
    expect(allNull.paths).toEqual([]);
    expect(allNull.dots).toEqual([]);
  });

  it("scales to a hint above the data, for the ceiling line", () => {
    const chart = buildLineChart([250], 100, 100, 0, 500);
    expect(chart.yMax).toBe(500);
    expect(chart.dots[0]?.y).toBe(50);
    expect(chart.yFor(500)).toBe(0);
  });
});
