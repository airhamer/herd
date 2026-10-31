export interface QualityCategoryInfo {
  key: string;
  label: string;
  count: number;
  optIn: boolean;
  source: string;
}
export const QUALITY_CATEGORIES: readonly QualityCategoryInfo[];
export const QUALITY_CATEGORY_KEYS: readonly string[];
export const QUALITY_DEFAULT_CATEGORIES: readonly string[];
export const QUALITY_CONCURRENCY_OPTIONS: readonly number[];
export const QUALITY_DEFAULT_CONCURRENCY: number;
export const QUALITY_NOISE_P: number;
export const QUALITY_HISTORY_LIMIT: number;
export function normalizeQualityCategories(raw: unknown): string[];
export function qualityRequestCount(keys: string[]): number;
export function qualityCategoryLabel(key: string): string;
