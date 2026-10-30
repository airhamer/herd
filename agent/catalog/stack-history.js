/**
 * stack-history.js — Proven stack tracking.
 *
 * A "Proven" stack is one that has been observed running successfully
 * (no OOM, completed generations, etc.) as a group in the past.
 *
 * This is the source of the "Proven" category.
 *
 * Simple file-backed store for now (similar to recipes.json).
 * Later: integrate with server-side persistent store + audit logs.
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_HISTORY_PATH = '/app/agent/config/stack-history.json';

export interface ProvenRun {
  timestamp: number;
  componentNames: string[];
  success: boolean;
  durationMs?: number;
  notes?: string;
}

export interface StackHistoryFile {
  version: number;
  runs: ProvenRun[];
}

/**
 * Simple manager for stack run history.
 */
export class StackHistory {
  private historyPath: string;
  private runs: ProvenRun[] = [];

  constructor(historyPath: string = DEFAULT_HISTORY_PATH) {
    this.historyPath = historyPath;
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(this.historyPath)) {
        const raw = fs.readFileSync(this.historyPath, 'utf8');
        const data: StackHistoryFile = JSON.parse(raw);
        this.runs = Array.isArray(data.runs) ? data.runs : [];
      }
    } catch (e) {
      // start empty on error
      this.runs = [];
    }
  }

  private save() {
    try {
      const dir = path.dirname(this.historyPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const data: StackHistoryFile = { version: 1, runs: this.runs };
      fs.writeFileSync(this.historyPath, JSON.stringify(data, null, 2));
    } catch (e) {
      // best effort
    }
  }

  /** Record a run of a set of components. */
  recordRun(componentNames: string[], success: boolean, durationMs?: number, notes?: string) {
    const sorted = [...new Set(componentNames)].sort();
    this.runs.push({
      timestamp: Date.now(),
      componentNames: sorted,
      success,
      durationMs,
      notes,
    });
    // keep only last 500 for now
    if (this.runs.length > 500) this.runs = this.runs.slice(-500);
    this.save();
  }

  /** Has this exact set (or superset) ever succeeded? */
  isProven(componentNames: string[]): boolean {
    const target = new Set([...new Set(componentNames)].sort());
    return this.runs.some(run => {
      if (!run.success) return false;
      const runSet = new Set(run.componentNames);
      // all selected were part of a successful run together
      return Array.from(target).every(c => runSet.has(c));
    });
  }

  /** Get recent proven combinations (for UI suggestions). */
  getRecentProven(limit = 20): string[][] {
    const proven = this.runs
      .filter(r => r.success)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map(r => r.componentNames);
    return proven;
  }
}

export function createStackHistory(path?: string) {
  return new StackHistory(path);
}

export default { StackHistory, createStackHistory };