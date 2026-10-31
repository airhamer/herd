import { describe, expect, it } from "vitest";
import { aggregateMetrics, type MetricPart } from "./groupAggregate";

function part(o: { total: number; avail: number; usage: number; temp: number | null; draw: number; limit: number; unified?: boolean; vramUsed?: number; vramTotal?: number; cpu?: number; cpuTemp?: number }): MetricPart {
  return {
    mem: { usedMB: o.total - o.avail, totalMB: o.total, availableMB: o.avail, percentage: 0 },
    gpu: {
      temperature: o.temp,
      usage: o.usage,
      powerDraw: o.draw,
      powerLimit: o.limit,
      vramUsedMB: o.vramUsed ?? 0,
      vramTotalMB: o.vramTotal ?? o.total,
      vramPercentage: 0,
      vramAvailableMB: 0,
      processes: [],
      unifiedMemory: o.unified ?? true,
    },
    cpu: { usage: o.cpu ?? 0, temperature: o.cpuTemp ?? 40, draw: 0, tdp: 0 },
  } as MetricPart;
}

describe("aggregateMetrics (SC5d)", () => {
  it("sums memory and power, averages usage, takes the hottest temperature", () => {
    const a = aggregateMetrics([
      part({ total: 122_880, avail: 20_000, usage: 90, temp: 70, draw: 100, limit: 140, cpu: 10, cpuTemp: 60 }),
      part({ total: 122_880, avail: 24_000, usage: 50, temp: 62, draw: 80, limit: 140, cpu: 30, cpuTemp: 66 }),
    ]);
    expect(a.parts).toBe(2);
    expect(a.reporting).toBe(2);
    expect(a.pool?.totalMB).toBe(245_760);
    expect(a.pool?.availableMB).toBe(44_000);
    expect(a.gpu).toMatchObject({ usage: 70, temperatureMax: 70, powerDraw: 180, powerLimit: 280, unified: true });
    expect(a.cpu).toEqual({ usage: 20, temperatureMax: 66 });
  });

  it("sums discrete VRAM (reusable for multi-GPU hosts, #30)", () => {
    const a = aggregateMetrics([
      part({ total: 65_536, avail: 30_000, usage: 10, temp: null, draw: 50, limit: 300, unified: false, vramUsed: 4_000, vramTotal: 24_000 }),
      part({ total: 65_536, avail: 30_000, usage: 30, temp: 50, draw: 60, limit: 300, unified: false, vramUsed: 6_000, vramTotal: 24_000 }),
    ]);
    expect(a.gpu).toMatchObject({ unified: false, vramUsedMB: 10_000, vramTotalMB: 48_000, temperatureMax: 50 });
  });

  it("handles parts with no readings", () => {
    const a = aggregateMetrics([{ mem: null, gpu: null, cpu: null }]);
    expect(a).toEqual({ parts: 1, reporting: 0, pool: null, gpu: null, cpu: null });
    expect(aggregateMetrics([]).parts).toBe(0);
  });
});
