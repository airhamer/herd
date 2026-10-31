import { describe, expect, it } from "vitest";
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { render } from "../../testing/render";
import { ROCE_COUNTER_ROWS, RocePanel, pfcLabel } from "./RocePanel";

function port(patch: Partial<RoceDevice> = {}): RoceDevice {
  return {
    name: "mlx5_0",
    netdev: "ens1f0",
    state: "ACTIVE",
    physState: "LinkUp",
    active: true,
    everActive: true,
    rateGbps: 100,
    linkLayer: "Ethernet",
    operstate: "up",
    mtu: 4200,
    speedMbps: null,
    rxBps: 512,
    txBps: 3 * 1024 * 1024 * 1024,
    rxErrors: 1200,
    txErrors: 0,
    rxDropped: 0,
    txDropped: 0,
    counters: { packet_seq_err: 2, rp_cnp_handled: 40 },
    deltas: { packet_seq_err: 2, rp_cnp_handled: 0 },
    loss: { rising: ["packet_seq_err"], streak: 1, ethStreak: 0 },
    eth: { tx_discards_phy: 6 },
    flowControl: { rx: false, tx: true },
    qos: { trust: "dscp", pfcPriorities: [3, 5], cableLen: 1, dscpMap: { "3": [24, 26] } },
    ...patch,
  };
}

const roce = (...devices: RoceDevice[]): RoceMetrics => ({ available: true, sampledAt: 0, devices });

describe("RocePanel", () => {
  it("is empty when there is nothing to show", () => {
    expect(render(<RocePanel roce={undefined} />).container.innerHTML).toBe("");
    expect(render(<RocePanel roce={roce()} />).container.innerHTML).toBe("");
  });

  it("summarises an up port", () => {
    const { container } = render(<RocePanel roce={roce(port())} className="extra" />);
    const text = container.textContent ?? "";
    for (const piece of [
      "RoCE / RDMA",
      "1/1 up",
      "ens1f0",
      "ACTIVE",
      "100 Gb/s",
      "MTU 4200",
      "512 B/s",
      "3.0 GB/s",
      "1,200 err · 0 drop",
      "PFC on: 3, 5",
      "trust dscp",
      "pause tx",
      "loss rising",
      "prio 3: DSCP 24,26",
      "RDMA counters",
      "Packet sequence errors",
      "CNPs handled",
      "TX discards",
    ]) {
      expect(text).toContain(piece);
    }
    expect(text).toContain("+2");
    expect(container.querySelector(".panel-roce.extra")).not.toBeNull();
    const row = container.querySelector('[data-testid="roce-mlx5_0"]');
    expect(row?.className).not.toContain("opacity-70");
  });

  it("prefers the netdev speed and hides absent facts", () => {
    const quiet = port({
      speedMbps: 200000,
      flowControl: { rx: false, tx: false },
      qos: null,
      loss: { rising: [], streak: 0, ethStreak: 0 },
      rxBps: null,
    });
    const text = render(<RocePanel roce={roce(quiet)} />).container.textContent ?? "";
    expect(text).toContain("200 Gb/s");
    expect(text).not.toContain("100 Gb/s");
    expect(text).not.toContain("pause");
    expect(text).not.toContain("PFC");
    expect(text).not.toContain("loss rising");
    expect(text).toContain("↓ —");
  });

  it("dims a port that went down and lists ports that never came up", () => {
    const { container } = render(
      <RocePanel
        roce={roce(
          port({ active: false, state: "DOWN" }),
          port({ name: "mlx5_2", netdev: null, active: false, everActive: false }),
          port({ name: "mlx5_3", netdev: "ens3", active: false, everActive: false }),
        )}
      />,
    );
    expect(container.querySelector('[data-testid="roce-mlx5_0"]')?.className).toContain("opacity-70");
    expect(container.querySelector('[data-testid="roce-mlx5_2"]')).toBeNull();
    expect(container.textContent).toContain("2 ports not connected: mlx5_2, ens3");
    expect(container.textContent).toContain("0/3 up");
  });

  it("labels PFC and keeps the counter order", () => {
    expect(pfcLabel(port({ qos: { trust: null, pfcPriorities: [], cableLen: null, dscpMap: null } }))).toEqual({
      text: "PFC off",
      tone: "neutral",
    });
    expect(pfcLabel(port())).toEqual({ text: "PFC on: 3, 5", tone: "good" });
    expect(pfcLabel(port({ qos: null }))).toBeNull();
    expect(ROCE_COUNTER_ROWS.filter((r) => r.loss)).toHaveLength(7);
    expect(ROCE_COUNTER_ROWS[0].key).toBe("out_of_buffer");
  });
});
