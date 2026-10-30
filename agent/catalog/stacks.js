/**
 * stacks.js — Stack category calculation and helpers (new 2026-10-29).
 *
 * Terminology:
 * - Component = a loadable serving "lane" (llm recipe with .lane slot).
 * - Stack = user-selected group of Components.
 *
 * Categories (computed when user selects Components in the UI):
 *   proven          - history shows they ran together successfully (no OOM).
 *   calculated      - current resource math says they should fit comfortably.
 *   not_recommended - math says tight / close to the edge.
 *   blocked         - definite insufficient resources.
 *
 * This is the "Calculated / Not recommended / Blocked" engine.
 * "Proven" is layered on top from history (see later pieces).
 *
 * Pure / testable. Reuses existing footprintMB, MemoryBudget ideas.
 */

import { MemoryBudget } from '../../shared/types'; // for reference, not runtime dep

export type StackCategory = 'proven' | 'calculated' | 'not_recommended' | 'blocked';

/**
 * Minimal view of a Component for stack calculations.
 */
export interface ComponentForStackCalc {
  name: string;
  footprintMB: number;          // from recipe
  contextLength?: number | null;
  // future: kvEstimateMB, memFraction, etc.
}

/**
 * Basic resource calculator.
 * Returns a category based on summed footprints vs available memory.
 *
 * Heuristics (tunable):
 * - blocked: sum > 95% of usable (total - floor - headroom)
 * - not_recommended: sum > 80% but <= 95%
 * - calculated: sum <= 80%
 *
 * Later we will incorporate:
 * - live MemoryBudget from the node
 * - KV pool usage
 * - context window overlap
 * - proven history override
 *
 * @param components selected Components
 * @param totalMB total unified memory on the box
 * @param floorMB hard floor (e.g. 3 GiB)
 * @param currentUsedMB current used (optional, for tighter calc)
 */
export function calculateStackCategory(
  components: ComponentForStackCalc[],
  totalMB: number,
  floorMB: number = 3072, // ~3 GiB default
  currentUsedMB: number = 0,
  isProven: boolean = false  // from stack-history
): StackCategory {
  if (isProven) return 'proven';

  if (!components || components.length === 0) {
    return 'calculated';
  }

  const sumFootprint = components.reduce((acc, c) => acc + (c.footprintMB || 0), 0);
  const usable = Math.max(0, totalMB - floorMB - currentUsedMB);

  // Very rough headroom for transient + KV + system
  const headroom = Math.max(2048, Math.floor(totalMB * 0.08)); // at least 2 GiB or 8%

  const effectiveUsable = Math.max(0, usable - headroom);

  const ratio = effectiveUsable > 0 ? sumFootprint / effectiveUsable : 1.0;

  if (ratio > 0.95) return 'blocked';
  if (ratio > 0.80) return 'not_recommended';
  return 'calculated';
}

/**
 * Convenience: given a live MemoryBudget + list of component footprints.
 */
export function calculateFromBudget(
  components: ComponentForStackCalc[],
  budget: { totalMB: number; usedMB?: number; floorMB?: number }
): StackCategory {
  return calculateStackCategory(
    components,
    budget.totalMB,
    budget.floorMB ?? 3072,
    budget.usedMB ?? 0
  );
}

export default {
  calculateStackCategory,
  calculateFromBudget,
};