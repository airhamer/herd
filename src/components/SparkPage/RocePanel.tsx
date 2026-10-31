// RoCE / RDMA panel on the unit page (docs/specs/roce.md §5).
// LIC2 clean-room rewrite: written from the spec, not from upstream code.
import type { RoceDevice, RoceMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";
import { Tag, type TagTone } from "../ui/Tag";

type CounterRow = { key: string; label: string; loss?: boolean };

const lossRow = (key: string, label: string): CounterRow => ({ key, label, loss: true });

/** hw_counters listed in the panel, in display order. Loss rows turn amber when they grow. */
export const ROCE_COUNTER_ROWS: CounterRow[] = [
  lossRow("out_of_buffer", "Out of buffer"),
  lossRow("packet_seq_err", "Packet sequence errors"),
  lossRow("local_ack_timeout_err", "Local ACK timeouts"),
  lossRow("rnr_nak_retry_err", "RNR NAK retries"),
  lossRow("implied_nak_seq_err", "Implied NAK errors"),
  lossRow("req_transport_retries_exceeded", "Transport retries exceeded"),
  lossRow("rx_icrc_encapsulated", "ICRC errors"),
  { key: "np_ecn_marked_roce_packets", label: "ECN-marked packets" },
  { key: "np_cnp_sent", label: "CNPs sent" },
  { key: "rp_cnp_handled", label: "CNPs handled" },
  { key: "roce_adp_retrans", label: "Adaptive retransmits" },
  { key: "duplicate_request", label: "Duplicate requests" },
];

/** ethtool -S counters shown after the RDMA ones. */
const PORT_COUNTER_ROWS: CounterRow[] = [
  { key: "rx_discards_phy", label: "RX discards" },
  { key: "tx_discards_phy", label: "TX discards" },
  { key: "rx_crc_errors_phy", label: "CRC errors" },
  { key: "rx_pause_ctrl_phy", label: "Pause frames received" },
  { key: "tx_pause_ctrl_phy", label: "Pause frames sent" },
];

const UNITS = ["B/s", "KB/s", "MB/s", "GB/s"];

/** Bytes per second, 1024-based, one decimal above bytes; "—" when unknown. */
function rateText(bytesPerSec: number | null): string {
  if (bytesPerSec == null) return "—";
  let value = Math.round(bytesPerSec);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B/s` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

const count = (v: number | null | undefined) => (typeof v === "number" ? v.toLocaleString() : "—");

/** PFC summary from mlnx_qos, or null when it could not be read. */
export function pfcLabel(d: RoceDevice): { text: string; tone: "good" | "neutral" | "warn" } | null {
  const enabled = d.qos?.pfcPriorities;
  if (!Array.isArray(enabled)) return null;
  if (enabled.length === 0) return { text: "PFC off", tone: "neutral" };
  return { text: `PFC on: ${enabled.join(", ")}`, tone: "good" };
}

function stateTone(d: RoceDevice): TagTone {
  if (d.active) return "good";
  if (d.everActive) return "bad";
  return "neutral";
}

function speedText(d: RoceDevice): string | null {
  if (d.speedMbps != null) return `${d.speedMbps / 1000} Gb/s`;
  if (d.rateGbps != null) return `${d.rateGbps} Gb/s`;
  return null;
}

function pauseText(fc: RoceDevice["flowControl"]): string | null {
  if (!fc) return null;
  const dirs = [fc.rx ? "rx" : null, fc.tx ? "tx" : null].filter(Boolean);
  return dirs.length ? `pause ${dirs.join("/")}` : null;
}

function dscpText(d: RoceDevice): string | null {
  const map = d.qos?.dscpMap;
  if (!map) return null;
  const parts = Object.keys(map).map((prio) => `prio ${prio}: DSCP ${map[prio].join(",")}`);
  return parts.length ? parts.join(" · ") : null;
}

function CounterTable({ d }: { d: RoceDevice }) {
  const rdma = ROCE_COUNTER_ROWS.filter((row) => d.counters[row.key] != null);
  const port = d.eth ? PORT_COUNTER_ROWS.filter((row) => d.eth?.[row.key] != null) : [];
  return (
    <table className="mt-1.5 w-full border-collapse">
      <tbody>
        {rdma.map((row) => {
          const grew = d.deltas[row.key] ?? 0;
          return (
            <tr key={row.key} className={row.loss && grew > 0 ? "text-warning" : undefined}>
              <td className="py-0.5 pr-2 text-muted">{row.label}</td>
              <td className="py-0.5 pr-2 text-right font-tabular text-text">{count(d.counters[row.key])}</td>
              <td className="py-0.5 text-right font-tabular text-muted">{grew > 0 ? `+${grew.toLocaleString()}` : null}</td>
            </tr>
          );
        })}
        {port.map((row) => (
          <tr key={row.key}>
            <td className="py-0.5 pr-2 text-muted">{row.label}</td>
            <td className="py-0.5 pr-2 text-right font-tabular text-text">{count(d.eth?.[row.key])}</td>
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PortCard({ d }: { d: RoceDevice }) {
  const speed = speedText(d);
  const pfc = pfcLabel(d);
  const pause = pauseText(d.flowControl);
  const dscp = dscpText(d);
  const rising = d.loss.rising;
  const frame = "space-y-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0";
  return (
    <div data-testid={`roce-${d.name}`} className={d.active ? frame : `${frame} opacity-70`}>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span title={d.name} className="min-w-0 truncate font-tabular text-sm text-text-strong">
          {d.netdev ?? d.name}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Tag tone={stateTone(d)} title={d.physState ?? undefined}>
            {d.state ?? "unknown"}
          </Tag>
          {speed ? <Tag>{speed}</Tag> : null}
          {d.mtu != null ? <Tag title="MTU">{`MTU ${d.mtu}`}</Tag> : null}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-tabular text-xs text-muted">
        <span>
          <span className="text-accent">↓</span> {rateText(d.rxBps)}
        </span>
        <span>
          <span className="text-accent">↑</span> {rateText(d.txBps)}
        </span>
        <span title="Frames dropped or in error on this interface">
          {`${count(d.rxErrors)} err · ${count(d.rxDropped)} drop`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {pfc ? (
          <Tag tone={pfc.tone} title="Priority flow control (mlnx_qos)">
            {pfc.text}
          </Tag>
        ) : null}
        {d.qos?.trust ? <Tag title="QoS trust mode">{`trust ${d.qos.trust}`}</Tag> : null}
        {pause ? <Tag title="Global pause (ethtool -a)">{pause}</Tag> : null}
        {rising.length ? (
          <Tag tone="warn" title={rising.join(", ")}>
            loss rising
          </Tag>
        ) : null}
      </div>
      {dscp ? <div className="font-tabular text-[10px] text-muted">{dscp}</div> : null}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">RDMA counters</summary>
        <CounterTable d={d} />
      </details>
    </div>
  );
}

/** Renders nothing for units without RDMA devices. */
export function RocePanel({ roce, className }: { roce: RoceMetrics | null | undefined; className?: string }) {
  const devices = roce?.devices ?? [];
  if (devices.length === 0) return null;
  const shown: RoceDevice[] = [];
  const neverUp: RoceDevice[] = [];
  for (const d of devices) (d.active || d.everActive ? shown : neverUp).push(d);
  const up = devices.reduce((n, d) => n + (d.active ? 1 : 0), 0);
  return (
    <Panel
      title="RoCE / RDMA"
      icon={<NetworkIcon />}
      accent
      className={["panel-roce", className].filter(Boolean).join(" ")}
      bodyClassName="space-y-3"
      actions={<Tag tone={up === devices.length ? "good" : "neutral"}>{`${up}/${devices.length} up`}</Tag>}
    >
      {shown.map((d) => (
        <PortCard key={d.name} d={d} />
      ))}
      {neverUp.length ? (
        <p className="text-xs text-muted">
          {`${neverUp.length} ${neverUp.length === 1 ? "port" : "ports"} not connected: `}
          {neverUp.map((d) => d.netdev ?? d.name).join(", ")}
        </p>
      ) : null}
    </Panel>
  );
}
