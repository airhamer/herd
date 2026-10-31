/**
 * Electricity price settings (issue #33). The default is a typical US
 * residential rate; a price of 0 hides the cost line.
 */
export const DEFAULT_ELECTRICITY_PRICE_PER_KWH = 0.17;
export const DEFAULT_ELECTRICITY_CURRENCY = "USD";
export const MAX_ELECTRICITY_PRICE_PER_KWH = 100;

/** A price per kWh in [0, 100]; anything unusable becomes the default. */
export function normalizePrice(value) {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0) return DEFAULT_ELECTRICITY_PRICE_PER_KWH;
  return Math.min(number, MAX_ELECTRICITY_PRICE_PER_KWH);
}

/** An ISO 4217-style code: three letters, upper-cased; otherwise the default. */
export function normalizeCurrency(value) {
  if (typeof value !== "string") return DEFAULT_ELECTRICITY_CURRENCY;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_ELECTRICITY_CURRENCY;
}
