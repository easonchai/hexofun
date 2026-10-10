/**
 * Path building for the daily paid rate chart. Pure, so the null-gap rule is
 * testable without a DOM. A null value ends the current line and the next
 * number starts a new one, which leaves a visible gap.
 */
export interface LineChart {
  /** One SVG path `d` per unbroken run of two or more points. */
  paths: string[];
  /** Every non-null point, so a run of one still shows as a dot. */
  dots: { x: number; y: number; index: number }[];
  /** The value at the top of the plot. */
  yMax: number;
  /** y for a value, so callers can draw a reference line (the ceiling). */
  yFor: (value: number) => number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function buildLineChart(
  values: readonly (number | null)[],
  width: number,
  height: number,
  pad: number,
  yMaxHint = 0,
): LineChart {
  const finite = values.filter((v): v is number => v !== null);
  const yMax = Math.max(yMaxHint, ...finite, 1);
  const xFor = (i: number): number =>
    values.length < 2 ? width / 2 : pad + (i / (values.length - 1)) * (width - 2 * pad);
  const yFor = (v: number): number => round1(height - pad - (v / yMax) * (height - 2 * pad));

  const paths: string[] = [];
  const dots: LineChart["dots"] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length >= 2) paths.push(run.join(" "));
    run = [];
  };
  values.forEach((v, i) => {
    if (v === null) return flush();
    const x = round1(xFor(i));
    const y = yFor(v);
    dots.push({ x, y, index: i });
    run.push(`${run.length === 0 ? "M" : "L"}${x} ${y}`);
  });
  flush();
  return { paths, dots, yMax, yFor };
}
