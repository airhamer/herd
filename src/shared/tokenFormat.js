// FLEET3 (#38): compact token counts for the Fleet token totals card.
// 950 → "950", 12_345 → "12.3K", 2_210_000 → "2.21M", 3.4e9 → "3.40B".
// Three significant digits from 1K up; null / non-finite → "—".

const UNITS = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

export function formatTokens(value) {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (let i = 0; i < UNITS.length; i += 1) {
    const [size, unit] = UNITS[i];
    if (abs >= size) {
      const scaled = abs / size;
      let text = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
      // 999.6K rounds to "1000": promote to the next unit.
      if (Number(text) >= 1000 && i > 0) {
        text = (abs / UNITS[i - 1][0]).toFixed(2);
        return `${sign}${text}${UNITS[i - 1][1]}`;
      }
      return `${sign}${text}${unit}`;
    }
  }
  return `${sign}${Math.round(abs)}`;
}

/** Share of `part` in `whole` as a whole percent string ("41%"), or "—". */
export function formatShare(part, whole) {
  if (!(whole > 0) || !Number.isFinite(part)) return "—";
  const pct = (part / whole) * 100;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
