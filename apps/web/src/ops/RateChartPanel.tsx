import { buildLineChart } from "./chart.js";
import { pct } from "./format.js";
import { Loading, Panel } from "./ui.js";
import { useOps } from "./useOps.js";

const W = 600;
const H = 200;
const PAD = 28;

/** The APR depositors were paid, one point a day. A day with no data is a gap. */
export function RateChartPanel() {
  const { daily, pool } = useOps();
  if (!daily) {
    return (
      <Panel id="rate-chart" title="Daily paid rate">
        <Loading />
      </Panel>
    );
  }
  const ceiling = pool?.live.rates.ceilingBps ?? 0;
  const chart = buildLineChart(
    daily.map((d) => d.aprBps),
    W,
    H,
    PAD,
    ceiling,
  );
  const first = daily[0]?.day;
  const last = daily[daily.length - 1]?.day;
  return (
    <Panel id="rate-chart" title="Daily paid rate">
      {chart.dots.length === 0 ? (
        <p className="ops-sync">No daily rates yet.</p>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Daily paid APR from ${first} to ${last}, up to ${pct(Math.round(chart.yMax))}`}
          className="ops-chart"
          data-testid="rate-chart"
        >
          <line x1={PAD} x2={W - PAD} y1={chart.yFor(0)} y2={chart.yFor(0)} className="ops-axis" />
          {ceiling > 0 && (
            <line
              x1={PAD}
              x2={W - PAD}
              y1={chart.yFor(ceiling)}
              y2={chart.yFor(ceiling)}
              className="ops-ceiling"
            />
          )}
          {chart.paths.map((d) => (
            <path key={d} d={d} className="ops-line" />
          ))}
          {chart.dots.map((dot) => (
            <circle key={dot.index} cx={dot.x} cy={dot.y} r={2.5} className="ops-dot">
              <title>{`${daily[dot.index]?.day}: ${pct(daily[dot.index]?.aprBps)}`}</title>
            </circle>
          ))}
          <text x={PAD} y={H - 6} className="ops-axis-label">
            {first}
          </text>
          <text x={W - PAD} y={H - 6} textAnchor="end" className="ops-axis-label">
            {last}
          </text>
          <text x={PAD} y={12} className="ops-axis-label">
            {pct(Math.round(chart.yMax))}
          </text>
        </svg>
      )}
    </Panel>
  );
}
