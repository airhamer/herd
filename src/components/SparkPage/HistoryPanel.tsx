// The unit page's History panel (docs/specs/unit-history.md §10): the
// server-side bucketed history of one unit, drawn as small multiples that
// share one crosshair. LIC2 clean-room rewrite, written from the spec.
import { useEffect, useMemo, useRef, useState } from "react";
import { getUnitHistory } from "../../api/client";
import type {
  HistoryLlmPoint,
  HistoryLlmSeries,
  HistoryPoint,
  HistoryStat,
  HistoryUnitSeries,
  MetricsHistoryData,
  MetricsHistoryRange,
  MetricsHistoryResponse,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { ActivityIcon } from "../ui/icons";
import { HistoryChart, type HistoryChartSeries, type HistoryThreshold } from "./HistoryChart";

export const HISTORY_RANGES: readonly MetricsHistoryRange[] = ["1h", "6h", "24h", "7d", "30d"];
/** Refresh interval while the panel is on screen and the tab is visible. */
export const HISTORY_POLL_MS = 30_000;
/** localStorage key holding the last chosen range. */
export const HISTORY_RANGE_KEY = "sparkdash.ui.history.range";

const SPAN_WORDS: Record<MetricsHistoryRange, string> = {
  "1h": "last hour",
  "6h": "last 6 hours",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
};

const isRange = (v: unknown): v is MetricsHistoryRange => HISTORY_RANGES.some((r) => r === v);

/** The stored range, or 1h when nothing valid is stored (or storage is blocked). */
export function readHistoryRange(): MetricsHistoryRange {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(HISTORY_RANGE_KEY);
  } catch {
    stored = null;
  }
  return isRange(stored) ? stored : "1h";
}

function rememberRange(range: MetricsHistoryRange): void {
  try {
    localStorage.setItem(HISTORY_RANGE_KEY, range);
  } catch {
    // Not remembering the choice is harmless.
  }
}

// ─── Value formatting ────────────────────────────────────

const GB = 1024;
const TB = 1024 * GB;

/** Megabytes as MB, GB or TB (GB and TB with one decimal). */
export function formatMb(mb: number): string {
  if (mb >= TB) return `${(mb / TB).toFixed(1)} TB`;
  if (mb >= GB) return `${(mb / GB).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/** One decimal for small values, whole numbers from 10 up. */
const compact = (v: number): string => (v < 10 ? v.toFixed(1) : String(Math.round(v)));
const asPercent = (v: number) => `${compact(v)}%`;
const asWatts = (v: number) => `${compact(v)} W`;

function asTokensPerSec(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"];
function asRate(bytesPerSec: number): string {
  let v = Math.round(bytesPerSec);
  if (v < 1024) return `${v} B/s`;
  let unit = 0;
  while (v >= 1024 && unit < RATE_UNITS.length - 1) {
    v /= 1024;
    unit++;
  }
  return `${v.toFixed(1)} ${RATE_UNITS[unit]}`;
}

function bucketWidthText(stepMs: number): string {
  return stepMs >= 60_000 ? `${Math.round(stepMs / 60_000)} min` : `${Math.round(stepMs / 1000)} s`;
}

/** Labels in the browser's own time zone (the app has no zone setting). */
function clockFormats(range: MetricsHistoryRange) {
  const hm = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  const md = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const mdhm = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const short = range === "1h" || range === "6h";
  const multiDay = range === "7d" || range === "30d";
  return {
    point: (t: number) => (short ? hm : mdhm).format(t),
    edge: (t: number) => (multiDay ? md : hm).format(t),
    clock: (t: number) => hm.format(t),
  };
}

// ─── Chart definitions ───────────────────────────────────

const COLOR = {
  primary: "var(--color-accent)",
  warm: "var(--color-warning)",
  neutral: "var(--color-text)",
  good: "var(--color-success)",
  bad: "var(--color-danger)",
};

/** Free-memory warning lines in MB, matching the live memory panels. */
const FREE_MEMORY_LINES = {
  unified: { low: 8 * GB, critical: 4 * GB },
  discrete: { low: 2 * GB, critical: 1 * GB },
} as const;

interface ChartSpec {
  id: string;
  title: string;
  series: HistoryChartSeries[];
  format: (v: number) => string;
  yMin?: number;
  yMax?: number;
  yUnit?: number;
  thresholds?: HistoryThreshold[];
}

/** All bucket times of the response, unit and LLM alike, ascending and unique. */
export function buildTimeline(data: MetricsHistoryData): number[] {
  const all = data.points.map((p) => p.t);
  for (const endpoint of data.llm) all.push(...endpoint.points.map((p) => p.t));
  return Array.from(new Set(all)).sort((a, b) => a - b);
}

/** Lay one field of a point list onto the timeline, null where it is missing. */
function onTimeline<K extends string>(
  timeline: readonly number[],
  points: ReadonlyArray<{ t: number } & Partial<Record<K, HistoryStat>>>,
  field: K,
  scale?: (v: number) => number,
): Array<HistoryStat | null> {
  const byTime = new Map<number, HistoryStat>();
  for (const p of points) {
    const stat = p[field] as HistoryStat | undefined;
    if (stat) byTime.set(p.t, stat);
  }
  return timeline.map((t) => {
    const s = byTime.get(t);
    if (!s) return null;
    if (!scale) return s;
    const scaled: HistoryStat = { avg: scale(s.avg), max: scale(s.max) };
    if (s.min != null) scaled.min = scale(s.min);
    return scaled;
  });
}

const reported = (values: ReadonlyArray<HistoryStat | null>) => values.some((v) => v !== null);

function chartSpecs(
  data: MetricsHistoryData,
  timeline: readonly number[],
  kind: string | undefined,
  temperatureUnit: "celsius" | "fahrenheit",
): ChartSpec[] {
  const unit = (field: HistoryUnitSeries, scale?: (v: number) => number) =>
    onTimeline<HistoryUnitSeries>(timeline, data.points as HistoryPoint[], field, scale);
  const fahrenheit = temperatureUnit === "fahrenheit";
  const degrees = fahrenheit ? (c: number) => c * 1.8 + 32 : undefined;
  const asDegrees = (v: number) => `${Math.round(v)}°${fahrenheit ? "F" : "C"}`;
  const discrete = kind === "host";
  const lines = FREE_MEMORY_LINES[discrete ? "discrete" : "unified"];

  const specs: ChartSpec[] = [
    {
      id: "gpuUtil",
      title: "GPU utilization",
      format: asPercent,
      yMin: 0,
      yMax: 100,
      series: [{ key: "gpuUtil", label: "GPU", color: COLOR.primary, band: "max", values: unit("gpuUtil") }],
    },
    {
      id: "gpuTemp",
      title: "GPU temperature",
      format: asDegrees,
      yUnit: 5,
      series: [{ key: "gpuTemp", label: "GPU", color: COLOR.warm, band: "max", values: unit("gpuTemp", degrees) }],
    },
    {
      id: "gpuPower",
      title: "GPU power",
      format: asWatts,
      yMin: 0,
      series: [{ key: "gpuPower", label: "Power", color: COLOR.neutral, band: "max", values: unit("gpuPower") }],
    },
    {
      id: "memFree",
      title: discrete ? "VRAM free" : "Memory free (unified)",
      format: formatMb,
      yMin: 0,
      yUnit: GB,
      thresholds: [
        { value: lines.low, label: `low ${formatMb(lines.low)}`, color: COLOR.warm },
        { value: lines.critical, label: `critical ${formatMb(lines.critical)}`, color: COLOR.bad },
      ],
      series: [{ key: "memFreeMB", label: "Free", color: COLOR.good, band: "min", values: unit("memFreeMB") }],
    },
    {
      id: "cpuUtil",
      title: "CPU utilization",
      format: asPercent,
      yMin: 0,
      yMax: 100,
      series: [{ key: "cpuUtil", label: "CPU", color: COLOR.primary, band: "max", values: unit("cpuUtil") }],
    },
    {
      id: "cpuTemp",
      title: "CPU temperature",
      format: asDegrees,
      yUnit: 5,
      series: [{ key: "cpuTemp", label: "CPU", color: COLOR.warm, band: "max", values: unit("cpuTemp", degrees) }],
    },
  ];

  const ramUsed = unit("ramUsedMB");
  if (discrete && reported(ramUsed)) {
    specs.push({
      id: "ramUsed",
      title: "RAM used",
      format: formatMb,
      yMin: 0,
      yUnit: GB,
      series: [{ key: "ramUsedMB", label: "Used", color: COLOR.primary, band: "max", values: ramUsed }],
    });
  }

  specs.push({
    id: "network",
    title: "Network",
    format: asRate,
    yMin: 0,
    series: [
      { key: "netRx", label: "↓ rx", color: COLOR.primary, values: unit("netRx") },
      { key: "netTx", label: "↑ tx", color: COLOR.good, values: unit("netTx") },
    ],
  });

  for (const { port, points } of data.llm) {
    const llm = (field: HistoryLlmSeries, scale?: (v: number) => number) =>
      onTimeline<HistoryLlmSeries>(timeline, points as HistoryLlmPoint[], field, scale);
    specs.push(
      {
        id: `llm-${port}-gen`,
        title: `Decode tok/s · :${port}`,
        format: asTokensPerSec,
        yMin: 0,
        series: [{ key: "genTps", label: "Decode", color: COLOR.primary, band: "max", values: llm("genTps") }],
      },
      {
        id: `llm-${port}-prefill`,
        title: `Prefill tok/s · :${port}`,
        format: asTokensPerSec,
        yMin: 0,
        series: [{ key: "prefillTps", label: "Prefill", color: COLOR.neutral, band: "max", values: llm("prefillTps") }],
      },
    );
    const kv = llm("kvUsage", (fraction) => fraction * 100);
    if (reported(kv)) {
      specs.push({
        id: `llm-${port}-kv`,
        title: `KV cache · :${port}`,
        format: asPercent,
        yMin: 0,
        yMax: 100,
        series: [{ key: "kvUsage", label: "KV", color: COLOR.warm, band: "max", values: kv }],
      });
    }
  }
  return specs;
}

// ─── Visibility and polling ──────────────────────────────

/** True while the referenced element intersects the viewport (always true without IntersectionObserver). */
function useInView<T extends Element>() {
  const node = useRef<T>(null);
  // With an observer, wait for its first report before counting as on screen.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = node.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      const latest = entries.at(-1);
      if (latest) setInView(latest.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [node, inView] as const;
}

function usePageVisible(): boolean {
  const read = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const [visible, setVisible] = useState(read);
  useEffect(() => {
    const onChange = () => setVisible(read());
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

interface Feed {
  /** Which unit and range this state belongs to. */
  owner: string;
  response?: MetricsHistoryResponse;
  fetchedAt?: number;
  error?: string;
}

/**
 * Fetches the unit's history now and every HISTORY_POLL_MS while `live`.
 * Pausing keeps what is on screen; a new unit or range starts empty.
 */
function useHistoryFeed(sparkId: string, range: MetricsHistoryRange, live: boolean): Feed {
  const owner = `${sparkId}\u0000${range}`;
  const [feed, setFeed] = useState<Feed>({ owner });

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    const pull = async () => {
      try {
        const response = await getUnitHistory(sparkId, range);
        if (!stopped) setFeed({ owner, response, fetchedAt: Date.now() });
      } catch (err) {
        if (stopped) return;
        const error = err instanceof Error ? err.message : String(err);
        setFeed((prev) => (prev.owner === owner ? { ...prev, error } : { owner, error }));
      }
    };
    void pull();
    const timer = setInterval(() => void pull(), HISTORY_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sparkId, range, live, owner]);

  return feed.owner === owner ? feed : { owner };
}

// ─── Panel ───────────────────────────────────────────────

export interface HistoryPanelProps {
  sparkId: string;
  kind?: string;
  temperatureUnit: "celsius" | "fahrenheit";
}

export function HistoryPanel({ sparkId, kind, temperatureUnit }: HistoryPanelProps) {
  const [range, setRange] = useState<MetricsHistoryRange>(readHistoryRange);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [box, inView] = useInView<HTMLDivElement>();
  const pageVisible = usePageVisible();
  const { response, fetchedAt, error } = useHistoryFeed(sparkId, range, inView && pageVisible);
  const clock = useMemo(() => clockFormats(range), [range]);

  const data = response && response.enabled ? response : null;
  const timeline = useMemo(() => (data ? buildTimeline(data) : []), [data]);
  const specs = useMemo(
    () => (data ? chartSpecs(data, timeline, kind, temperatureUnit) : []),
    [data, timeline, kind, temperatureUnit],
  );

  const choose = (next: MetricsHistoryRange) => {
    rememberRange(next);
    setCursorT(null);
    setRange(next);
  };

  const rangeChips = (
    <div role="group" aria-label="History range" className="flex items-center gap-1">
      {HISTORY_RANGES.map((r) => {
        const active = r === range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            onClick={() => choose(r)}
            className={`rounded-md px-2 py-0.5 text-[11px] ${
              active ? "bg-accent font-medium text-white" : "text-muted hover:bg-surface-hover"
            }`}
          >
            {r}
          </button>
        );
      })}
    </div>
  );

  const content = (() => {
    if (!response) {
      return error ? (
        <p className="text-xs text-danger">Could not load history: {error}</p>
      ) : (
        <p className="text-xs text-muted">Loading history…</p>
      );
    }
    if (!data) {
      return (
        <p className="text-xs text-muted">
          Metrics history is off on the server. Turn it on in Settings → Metrics history.
        </p>
      );
    }
    if (timeline.length === 0) {
      return (
        <p className="py-4 text-center text-xs text-muted">
          No history in this range yet. The server records every unit while it is online.
        </p>
      );
    }
    return (
      <>
        <p className="text-xs text-muted">
          Average per {bucketWidthText(data.stepMs)} · shaded: peak (low point for free memory) · gaps: offline or not
          reported
        </p>
        <div className="grid gap-3 lg:grid-cols-2">
          {specs.map((spec) => (
            <HistoryChart
              key={spec.id}
              {...spec}
              timeline={timeline}
              stepMs={data.stepMs}
              from={data.from}
              to={data.to}
              cursorT={cursorT}
              onCursor={setCursorT}
              formatTime={clock.point}
              formatAxisTime={clock.edge}
            />
          ))}
        </div>
      </>
    );
  })();

  return (
    <div ref={box}>
      <Panel
        title={`History · ${SPAN_WORDS[range]}`}
        icon={<ActivityIcon />}
        actions={rangeChips}
        bodyClassName="space-y-2"
      >
        {response && error && fetchedAt !== undefined ? (
          <p role="status" className="text-xs text-danger">
            Stale: could not refresh ({error}). Showing data from {clock.clock(fetchedAt)}.
          </p>
        ) : null}
        {content}
      </Panel>
    </div>
  );
}
