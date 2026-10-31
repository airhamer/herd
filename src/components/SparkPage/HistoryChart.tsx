// One chart of the History panel (docs/specs/unit-history.md §10).
// LIC2 clean-room rewrite: written from the spec, not from upstream code.
//
// The SVG uses a fixed coordinate box stretched to the element
// (preserveAspectRatio="none", non-scaling strokes); all text is HTML on top,
// so it stays sharp at any width. The crosshair timestamp belongs to the
// panel, so every chart shows the same bucket.
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { HistoryStat } from "../../api/types";

const BOX_W = 300;
const BOX_H = 90;
const INSET = 3;
/** Neighbouring buckets more than this many steps apart are not joined. */
const MAX_JOIN_STEPS = 1.5;
const NICE_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];

/** Stroke presets; strokes keep their pixel width while the SVG stretches. */
const HAIR = { strokeWidth: 1, vectorEffect: "non-scaling-stroke" } as const;
const DOT = { strokeWidth: 2.5, strokeLinecap: "round", vectorEffect: "non-scaling-stroke" } as const;
const TRACE = {
  fill: "none",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  vectorEffect: "non-scaling-stroke",
} as const;

export interface HistoryChartSeries {
  key: string;
  label: string;
  /** CSS colour, usually a theme variable. */
  color: string;
  /** One entry per timeline slot; null where the bucket has no value. */
  values: ReadonlyArray<HistoryStat | null>;
  /** Shade between the average and the bucket's max (or min). */
  band?: "max" | "min";
}

export interface HistoryThreshold {
  value: number;
  label: string;
  color: string;
}

export interface HistoryChartProps {
  id: string;
  title: string;
  /** Ascending bucket start times shared by the whole panel. */
  timeline: readonly number[];
  stepMs: number;
  from: number;
  to: number;
  series: readonly HistoryChartSeries[];
  format: (v: number) => string;
  yMin?: number;
  yMax?: number;
  /** Granularity auto bounds snap to (e.g. 1024 MB, 5 degrees). */
  yUnit?: number;
  thresholds?: readonly HistoryThreshold[];
  cursorT: number | null;
  onCursor: (t: number | null) => void;
  formatTime: (t: number) => string;
  formatAxisTime: (t: number) => string;
}

/** Groups of timeline indexes to draw as one connected line each. */
export function segmentRuns(
  timeline: readonly number[],
  values: ReadonlyArray<HistoryStat | null>,
  stepMs: number,
): number[][] {
  const out: number[][] = [];
  let current: number[] | null = null;
  timeline.forEach((t, i) => {
    if (values[i] == null) {
      current = null;
      return;
    }
    const last = current?.at(-1);
    if (current === null || last === undefined || t - timeline[last] > stepMs * MAX_JOIN_STEPS) {
      current = [];
      out.push(current);
    }
    current.push(i);
  });
  return out;
}

/** Index of the timeline value closest to t (the earlier one on a tie); -1 when empty. */
export function nearestIndex(timeline: readonly number[], t: number): number {
  const n = timeline.length;
  if (n === 0) return -1;
  let low = 0;
  let high = n;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (timeline[mid] >= t) high = mid;
    else low = mid + 1;
  }
  if (low === n) return n - 1;
  if (low === 0) return 0;
  return t - timeline[low - 1] <= timeline[low] - t ? low - 1 : low;
}

function roundUpNice(v: number): number {
  if (!(v > 0)) return v;
  const decade = Math.pow(10, Math.floor(Math.log10(v)));
  const step = NICE_STEPS.find((s) => v <= s * decade * (1 + 1e-12));
  return (step ?? 10) * decade;
}

/** Vertical range for the chart, or null when no series has a value. */
export function yDomain(
  series: readonly HistoryChartSeries[],
  yMin?: number,
  yMax?: number,
  thresholds: readonly HistoryThreshold[] = [],
  yUnit = 1,
): { lo: number; hi: number } | null {
  const seen: number[] = [];
  for (const s of series) {
    for (const v of s.values) {
      if (!v) continue;
      seen.push(v.avg);
      if (s.band === "max") seen.push(v.max);
      if (s.band === "min" && v.min != null) seen.push(v.min);
    }
  }
  if (seen.length === 0) return null;
  const marks = thresholds.map((th) => th.value);
  let lo = Math.min(...seen, ...marks);
  let hi = Math.max(...seen, ...marks);
  if (yMin !== undefined) lo = Math.min(lo, yMin);
  if (yMax !== undefined) hi = Math.max(hi, yMax);

  if (yMax === undefined && marks.length) {
    // Room for the label drawn above the top threshold line.
    const top = Math.max(...marks);
    const base = Math.min(lo, 0);
    hi = Math.max(hi, top + 0.25 * (top - base));
  }
  if (yMin === undefined) {
    const spread = hi - lo;
    const air = spread > 0 ? spread / 10 : lo !== 0 ? Math.abs(lo) / 10 : 1;
    const snap = Math.max(yUnit, Math.pow(10, Math.floor(Math.log10(spread + air))));
    lo = Math.floor((lo - air) / snap) * snap;
  }
  if (yMax === undefined) hi = yUnit * roundUpNice(hi / yUnit);
  if (!(hi > lo)) hi = lo + 1;
  return { lo, hi };
}

/** Newest timeline index where any series has a value. */
function newestWithData(series: readonly HistoryChartSeries[], length: number): number | null {
  for (let i = length - 1; i >= 0; i--) if (series.some((s) => s.values[i] != null)) return i;
  return null;
}

function bandEdge(s: HistoryChartSeries, v: HistoryStat): number {
  if (s.band === "max") return v.max;
  return v.min ?? v.avg;
}

export function HistoryChart(props: HistoryChartProps) {
  const { id, title, timeline, stepMs, from, to, series, format, thresholds = [], cursorT, onCursor } = props;
  const plotEl = useRef<HTMLDivElement>(null);
  const [hot, setHot] = useState(false); // pointer or keyboard is on this chart
  const [hasFocus, setHasFocus] = useState(false);
  const tipId = useId();

  const domain = yDomain(series, props.yMin, props.yMax, thresholds, props.yUnit);
  const width = Math.max(1, to - from);
  const x = (t: number) => Math.max(0, Math.min(BOX_W, ((t + stepMs / 2 - from) / width) * BOX_W));
  const y = (v: number) =>
    domain ? BOX_H - INSET - ((v - domain.lo) / (domain.hi - domain.lo)) * (BOX_H - 2 * INSET) : BOX_H;
  const xy = (i: number, v: number) => `${x(timeline[i]).toFixed(2)},${y(v).toFixed(2)}`;

  const at = cursorT === null ? -1 : nearestIndex(timeline, cursorT);
  const cursorOn = domain !== null && at >= 0;
  const shownIdx = cursorOn ? at : newestWithData(series, timeline.length);
  const cursorX = cursorOn ? x(timeline[at]) : null;
  const cursorPct = cursorX === null ? null : (100 * cursorX) / BOX_W;
  const tooltipOn = cursorOn && hot;

  const select = (i: number | null) => onCursor(i === null ? null : (timeline[i] ?? null));

  const follow = (e: PointerEvent<HTMLDivElement>) => {
    const box = plotEl.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || !timeline.length) return;
    const share = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
    setHot(true);
    select(nearestIndex(timeline, from + share * width - stepMs / 2));
  };

  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = timeline.length - 1;
    if (last < 0) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onCursor(null);
      return;
    }
    const from = at >= 0 ? at : last;
    const target: Record<string, number> = {
      ArrowLeft: at >= 0 ? Math.max(0, from - 1) : from,
      ArrowRight: Math.min(last, from + 1),
      Home: 0,
      End: last,
    };
    if (!(e.key in target)) return;
    e.preventDefault();
    setHot(true);
    select(target[e.key]);
  };

  const gridLines = [INSET, BOX_H / 2, BOX_H - INSET];

  return (
    <div data-chart={id} className="flex flex-col gap-1">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[10px] uppercase tracking-wider text-muted">{title}</span>
        <span className="flex shrink-0 items-center gap-2 font-tabular text-xs">
          {series.map((s) => {
            const v = shownIdx === null ? null : s.values[shownIdx];
            return (
              <span key={s.key} data-readout={s.key}>
                {series.length > 1 ? <small className="mr-1 text-muted">{s.label}</small> : null}
                <b style={{ color: s.color }}>{v === null || v === undefined ? "—" : format(v.avg)}</b>
              </span>
            );
          })}
        </span>
      </div>

      <div className="flex gap-1">
        <div
          aria-hidden="true"
          style={{ height: BOX_H }}
          className="flex w-12 shrink-0 flex-col items-end justify-between font-tabular text-[10px] text-muted"
        >
          <span data-axis="ymax">{domain && format(domain.hi)}</span>
          <span data-axis="ymin">{domain && format(domain.lo)}</span>
        </div>

        <div
          ref={plotEl}
          role="group"
          tabIndex={domain ? 0 : -1}
          aria-label={`${title}, ${props.formatTime(from)} to ${props.formatTime(to)}. Arrow keys step through the buckets, Escape clears.`}
          aria-describedby={tooltipOn ? tipId : undefined}
          className="relative min-w-0 flex-1 cursor-crosshair rounded-sm outline-none focus:ring-1 focus:ring-accent"
          onKeyDown={keys}
          onPointerDown={follow}
          onPointerMove={follow}
          onPointerLeave={() => {
            setHot(false);
            if (!hasFocus) onCursor(null);
          }}
          onFocus={() => {
            setHasFocus(true);
            setHot(true);
            if (at < 0 && timeline.length) select(timeline.length - 1);
          }}
          onBlur={() => {
            setHasFocus(false);
            setHot(false);
            onCursor(null);
          }}
        >
          <svg aria-hidden="true" viewBox={`0 0 ${BOX_W} ${BOX_H}`} preserveAspectRatio="none" style={{ height: BOX_H }}>
            {gridLines.map((gy, i) => (
              <line
                key={gy}
                x1={0}
                x2={BOX_W}
                y1={gy}
                y2={gy}
                {...HAIR}
                stroke="var(--color-border)"
                strokeDasharray={i === gridLines.length - 1 ? undefined : "2 4"}
              />
            ))}
            {domain
              ? thresholds.map((th) => (
                  <line
                    key={th.label}
                    data-threshold={th.label}
                    x1={0}
                    x2={BOX_W}
                    y1={y(th.value)}
                    y2={y(th.value)}
                    {...HAIR}
                    style={{ stroke: th.color, opacity: 0.8, strokeDasharray: "4 3" }}
                  />
                ))
              : null}
            {domain
              ? series.flatMap((s) =>
                  segmentRuns(timeline, s.values, stepMs).map((run, n) => {
                    const rowKey = `${s.key}:${n}`;
                    if (run.length === 1) {
                      const cx = x(timeline[run[0]]);
                      const cy = y(s.values[run[0]]!.avg);
                      return (
                        <line
                          key={rowKey}
                          data-series={s.key}
                          x1={cx - 0.6}
                          x2={cx + 0.6}
                          y1={cy}
                          y2={cy}
                          {...DOT}
                          style={{ stroke: s.color }}
                        />
                      );
                    }
                    const mid = run.map((i) => xy(i, s.values[i]!.avg));
                    const edge = s.band ? run.map((i) => xy(i, bandEdge(s, s.values[i]!))) : null;
                    return (
                      <g key={rowKey}>
                        {edge ? (
                          <polygon data-band={s.key} points={edge.concat([...mid].reverse()).join(" ")} fill={s.color} opacity={0.16} />
                        ) : null}
                        <polyline
                          data-series={s.key}
                          points={mid.join(" ")}
                          {...TRACE}
                          style={{ stroke: s.color }}
                        />
                      </g>
                    );
                  }),
                )
              : null}
            {cursorX !== null ? (
              <line
                data-crosshair=""
                x1={cursorX}
                x2={cursorX}
                y1={0}
                y2={BOX_H}
                {...HAIR}
                stroke="var(--color-muted)"
              />
            ) : null}
          </svg>

          {domain
            ? thresholds.map((th) => (
                <span
                  key={th.label}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-1 font-tabular text-[9px]"
                  style={{ color: th.color, top: `${(100 * y(th.value)) / BOX_H}%` }}
                >
                  {th.label}
                </span>
              ))
            : null}

          {cursorOn
            ? series.map((s) => {
                const v = s.values[at];
                return v ? (
                  <span
                    key={s.key}
                    aria-hidden="true"
                    className="pointer-events-none absolute h-[5px] w-[5px] rounded-full"
                    style={{
                      background: s.color,
                      left: `${cursorPct}%`,
                      top: `${(100 * y(v.avg)) / BOX_H}%`,
                      transform: "translate(-50%, -50%)",
                    }}
                  />
                ) : null;
              })
            : null}

          {domain ? null : (
            <p className="absolute inset-0 flex items-center justify-center text-xs text-muted">No data in this range</p>
          )}

          {tooltipOn && cursorPct !== null ? (
            <ChartTooltip
              id={tipId}
              leftPct={cursorPct}
              time={props.formatTime(timeline[at])}
              series={series}
              index={at}
              format={format}
            />
          ) : null}
        </div>
      </div>

      <div aria-hidden="true" className="flex justify-between font-tabular text-[10px] text-muted">
        <span data-axis="xstart">{props.formatAxisTime(from)}</span>
        <span data-axis="xend">{props.formatAxisTime(to)}</span>
      </div>
    </div>
  );
}

function ChartTooltip({
  id,
  leftPct,
  time,
  series,
  index,
  format,
}: {
  id: string;
  leftPct: number;
  time: string;
  series: readonly HistoryChartSeries[];
  index: number;
  format: (v: number) => string;
}) {
  // Flip to the left of the crosshair past the middle, so it stays inside the plot.
  const place = leftPct < 55 ? { left: `calc(${leftPct}% + 8px)` } : { right: `calc(${100 - leftPct}% + 8px)` };
  const extremes: string[] = [];
  for (const s of series) {
    const v = s.values[index];
    if (!v || !s.band) continue;
    const text = s.band === "max" ? `max ${format(v.max)}` : v.min != null ? `min ${format(v.min)}` : null;
    if (text) extremes.push(series.length > 1 ? `${s.label} ${text}` : text);
  }
  return (
    <div
      id={id}
      role="status"
      data-tooltip=""
      style={place}
      className="pointer-events-none absolute top-1 z-10 min-w-[7rem] rounded-lg border border-border bg-surface-elevated px-2 py-1.5 text-[11px] text-text shadow-lg"
    >
      <b>{time}</b>
      {series.map((s) => {
        const v = s.values[index];
        return (
          <div key={s.key} className="flex items-center gap-1.5">
            <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
            {s.label}
            <em className="ml-auto font-tabular not-italic">{v ? format(v.avg) : "—"}</em>
          </div>
        );
      })}
      {extremes.length ? (
        <div className="mt-1 border-t border-border pt-1 text-[10px] text-muted">{extremes.join(" · ")}</div>
      ) : null}
    </div>
  );
}
