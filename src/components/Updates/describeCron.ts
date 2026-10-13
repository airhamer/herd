// Small pure human-readable preview for 5-field crontab expressions
// (docs/SPEC-UPDATES.md §6.3, schedule dialog). Deliberately narrow: the
// agent's cron parser is authoritative for validity — this is a UI preview.
// Unknown-but-valid shapes fall back to `cron: <expr>`; anything the parser
// cannot understand yields null ("not a valid 5-field cron expression").
//
// Supported field classes: `*`, `*/n`, single value, comma list, `a-b` range,
// and SUN..SAT / JAN..DEC names. Day-of-week accepts 0-7 (7 = Sunday);
// ranges ending in 7 are not previewed as wrapping.

const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const DOW_ALIASES: Record<string, number> = {};
DOW_NAMES.forEach((n, i) => {
  DOW_ALIASES[n.toUpperCase()] = i;
});
const MONTH_ALIASES: Record<string, number> = {};
MONTH_NAMES.forEach((n, i) => {
  MONTH_ALIASES[n.toUpperCase()] = i + 1;
});

type FieldItem = { from: number; to: number };
type ParsedField =
  | { kind: "star" }
  | { kind: "step"; step: number }
  | { kind: "items"; items: FieldItem[] };

function resolveToken(tok: string, aliases?: Record<string, number>): number | null {
  const upper = tok.toUpperCase();
  if (aliases && upper in aliases) return aliases[upper];
  if (!/^\d+$/.test(tok)) return null;
  return Number(tok);
}

function parseField(
  raw: string,
  min: number,
  max: number,
  aliases?: Record<string, number>
): ParsedField | null {
  if (raw === "") return null;
  if (raw === "*") return { kind: "star" };
  const step = /^\*\/(\d+)$/.exec(raw);
  if (step) {
    const n = Number(step[1]);
    return n >= 1 ? { kind: "step", step: n } : null;
  }
  const items: FieldItem[] = [];
  for (const part of raw.split(",")) {
    const range = /^([^-]+)-([^-]+)$/.exec(part);
    if (range) {
      const a = resolveToken(range[1], aliases);
      const b = resolveToken(range[2], aliases);
      if (a == null || b == null || a < min || b > max || a > b) return null;
      items.push({ from: a, to: b });
      continue;
    }
    const v = resolveToken(part, aliases);
    if (v == null || v < min || v > max) return null;
    items.push({ from: v, to: v });
  }
  return items.length > 0 ? { kind: "items", items } : null;
}

const isStar = (f: ParsedField) => f.kind === "star";
const pad2 = (n: number) => String(n).padStart(2, "0");

function singleValue(f: ParsedField): number | null {
  return f.kind === "items" && f.items.length === 1 && f.items[0].from === f.items[0].to
    ? f.items[0].from
    : null;
}

function dowText(f: ParsedField): string {
  if (f.kind !== "items") return "*";
  return f.items
    .map((it) => (it.from === it.to ? DOW_NAMES[it.from] : `${DOW_NAMES[it.from]}-${DOW_NAMES[it.to]}`))
    .join(",");
}

function monthText(f: ParsedField): string {
  if (f.kind !== "items") return "*";
  return f.items
    .map((it) =>
      it.from === it.to
        ? MONTH_NAMES[it.from - 1]
        : `${MONTH_NAMES[it.from - 1]}-${MONTH_NAMES[it.to - 1]}`
    )
    .join(",");
}

function domText(f: ParsedField): string {
  if (f.kind !== "items") return "*";
  return f.items.map((it) => (it.from === it.to ? String(it.from) : `${it.from}-${it.to}`)).join(",");
}

/** `0 3 * * 0` → "weekly Sun 03:00"; invalid expression → null. */
export function describeCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const mon = parseField(parts[3], 1, 12, MONTH_ALIASES);
  const dowRaw = parseField(parts[4], 0, 7, DOW_ALIASES);
  if (!minute || !hour || !dom || !mon || !dowRaw) return null;

  // Normalize the 7==Sunday alias for single values only (ranges are not
  // previewed as wrapping).
  const dow: ParsedField =
    dowRaw.kind === "items"
      ? { kind: "items", items: dowRaw.items.map((it) => (it.from === 7 && it.to === 7 ? { from: 0, to: 0 } : it)) }
      : dowRaw;

  const m = singleValue(minute);
  const h = singleValue(hour);
  const time = m != null && h != null ? `${pad2(h)}:${pad2(m)}` : null;

  if (isStar(minute) && isStar(hour) && isStar(dom) && isStar(mon) && isStar(dow))
    return "every minute";
  if (minute.kind === "step" && isStar(hour) && isStar(dom) && isStar(mon) && isStar(dow))
    return `every ${minute.step} minutes`;
  if (m != null && hour.kind === "step" && isStar(dom) && isStar(mon) && isStar(dow))
    return `every ${hour.step} hours at :${pad2(m)}`;
  if (m != null && isStar(hour) && isStar(dom) && isStar(mon) && isStar(dow))
    return `every hour at :${pad2(m)}`;

  if (time != null) {
    if (!isStar(dow) && isStar(dom) && isStar(mon)) return `weekly ${dowText(dow)} ${time}`;
    if (!isStar(dom) && !isStar(mon)) return `yearly ${monthText(mon)} ${domText(dom)} ${time}`;
    if (!isStar(dom)) return `monthly on day ${domText(dom)} ${time}`;
    if (!isStar(mon)) return `yearly in ${monthText(mon)} ${time}`;
    return `daily ${time}`;
  }

  if (isStar(minute) && isStar(hour) && !isStar(dow) && isStar(dom) && isStar(mon))
    return `weekly ${dowText(dow)}`;
  return `cron: ${expr.trim()}`;
}
