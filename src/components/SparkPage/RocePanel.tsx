import type { RoceDevice, RoceMetrics } from "../../api/types";
import { Panel } from "../ui/Panel";
import { NetworkIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";

/** Counters worth showing, in this order; the rest stay in the API. */
export const ROCE_COUNTER_ROWS: { key: string; label: string; loss?: boolean }[] = [
  { key: "out_of_buffer", label: "Out of buffer", loss: true },
  { key: "packet_seq_err", label: "Packet sequence errors", loss: true },
  { key: "local_ack_timeout_err", label: "Local ACK timeouts", loss: true },
  { key: "rnr_nak_retry_err", label: "RNR NAK retries", loss: true },
  { key: "implied_nak_seq_err", label: "Implied NAK errors", loss: true },
  { key: "req_transport_retries_exceeded", label: "Transport retries exceeded", loss: true },
  { key: "rx_icrc_encapsulated", label: "ICRC errors", loss: true },
  { key: "np_ecn_marked_roce_packets", label: "ECN-marked packets" },
  { key: "np_cnp_sent", label: "CNPs sent" },
  { key: "rp_cnp_handled", label: "CNPs handled" },
  { key: "roce_adp_retrans", label: "Adaptive retransmits" },
  { key: "duplicate_request", label: "Duplicate requests" },
];

const ETH_ROWS: { key: string; label: string }[] = [
  { key: "rx_discards_phy", label: "RX discards" },
  { key: "tx_discards_phy", label: "TX discards" },
  { key: "rx_crc_errors_phy", label: "CRC errors" },
  { key: "rx_pause_ctrl_phy", label: "Pause frames received" },
  { key: "tx_pause_ctrl_phy", label: "Pause frames sent" },
];

const n = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString());

function formatBytesPerSec(bps: number): string {
  if (bps >= 1024 * 1024 * 1024) return `${(bps / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${bps} B/s`;
}

/** "PFC on: 3" / "PFC off" / null when unknown. */
export function pfcLabel(d: RoceDevice): { text: string; tone: "good" | "neutral" | "warn" } | null {
  const p = d.qos?.pfcPriorities;
  if (p == null) return null;
  return p.length > 0 ? { text: `PFC on: ${p.join(", ")}`, tone: "good" } : { text: "PFC off", tone: "neutral" };
}

function linkTone(d: RoceDevice): "good" | "warn" | "bad" | "neutral" {
  if (d.active) return "good";
  return d.everActive ? "bad" : "neutral";
}

function PortRow({ d }: { d: RoceDevice }) {
  const pfc = pfcLabel(d);
  const lossRising = d.loss.rising.length > 0;
  const speed =
    d.speedMbps != null ? `${d.speedMbps / 1000} Gb/s` : d.rateGbps != null ? `${d.rateGbps} Gb/s` : null;
  const dscp = d.qos?.dscpMap
    ? Object.entries(d.qos.dscpMap)
        .map(([prio, list]) => `prio ${prio}: DSCP ${list.join(",")}`)
        .join(" · ")
    : null;
  return (
    <div
      className={`space-y-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0 ${
        d.active ? "" : "opacity-70"
      }`}
      data-testid={`roce-${d.name}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <span className="min-w-0 truncate font-tabular text-sm text-text-strong" title={d.name}>
          {d.netdev ?? d.name}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <Tag tone={linkTone(d)} title={d.physState ?? undefined}>
            {d.state ?? "unknown"}
          </Tag>
          {speed && <Tag>{speed}</Tag>}
          {d.mtu != null && <Tag title="MTU">MTU {d.mtu}</Tag>}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3 font-tabular text-xs text-muted">
        <span>
          <span className="text-accent">↓</span>{" "}
          {d.rxBps == null ? "—" : formatBytesPerSec(Math.round(d.rxBps))}
        </span>
        <span>
          <span className="text-accent">↑</span>{" "}
          {d.txBps == null ? "—" : formatBytesPerSec(Math.round(d.txBps))}
        </span>
        <span title="Frames dropped or in error on this interface">
          {n(d.rxErrors)} err · {n(d.rxDropped)} drop
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {pfc && (
          <Tag tone={pfc.tone} title="Priority flow control (mlnx_qos)">
            {pfc.text}
          </Tag>
        )}
        {d.qos?.trust && <Tag title="QoS trust mode">trust {d.qos.trust}</Tag>}
        {d.flowControl && (d.flowControl.rx || d.flowControl.tx) && (
          <Tag title="Global pause (ethtool -a)">
            pause {d.flowControl.rx ? "rx" : ""}
            {d.flowControl.rx && d.flowControl.tx ? "/" : ""}
            {d.flowControl.tx ? "tx" : ""}
          </Tag>
        )}
        {lossRising && (
          <Tag tone="warn" title={d.loss.rising.join(", ")}>
            loss rising
          </Tag>
        )}
      </div>
      {dscp && <div className="font-tabular text-[10px] text-muted">{dscp}</div>}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">RDMA counters</summary>
        <table className="mt-1.5 w-full border-collapse">
          <tbody>
            {ROCE_COUNTER_ROWS.filter((r) => d.counters[r.key] != null).map((r) => {
              const delta = d.deltas[r.key] ?? 0;
              return (
                <tr key={r.key} className={r.loss && delta > 0 ? "text-warning" : ""}>
                  <td className="py-0.5 pr-2 text-muted">{r.label}</td>
                  <td className="py-0.5 pr-2 text-right font-tabular text-text">{n(d.counters[r.key])}</td>
                  <td className="py-0.5 text-right font-tabular text-muted">
                    {delta > 0 ? `+${delta.toLocaleString()}` : ""}
                  </td>
                </tr>
              );
            })}
            {d.eth &&
              ETH_ROWS.filter((r) => d.eth![r.key] != null).map((r) => (
                <tr key={r.key}>
                  <td className="py-0.5 pr-2 text-muted">{r.label}</td>
                  <td className="py-0.5 pr-2 text-right font-tabular text-text">{n(d.eth![r.key])}</td>
                  <td />
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** RoCE / RDMA ports of a unit (shown only when it has RDMA devices). */
export function RocePanel({ roce, className }: { roce: RoceMetrics | null | undefined; className?: string }) {
  if (!roce || roce.devices.length === 0) return null;
  // Ports that never came up are not noise worth a row, but keep them reachable.
  const live = roce.devices.filter((d) => d.active || d.everActive);
  const idle = roce.devices.filter((d) => !d.active && !d.everActive);
  const upCount = roce.devices.filter((d) => d.active).length;
  return (
    <Panel
      title="RoCE / RDMA"
      accent
      icon={<NetworkIcon />}
      className={`panel-roce ${className ?? ""}`}
      bodyClassName="space-y-3"
      actions={
        <Tag tone={upCount === roce.devices.length ? "good" : "neutral"}>
          {upCount}/{roce.devices.length} up
        </Tag>
      }
    >
      {live.map((d) => (
        <PortRow key={d.name} d={d} />
      ))}
      {idle.length > 0 && (
        <p className="text-xs text-muted">
          {idle.length} port{idle.length === 1 ? "" : "s"} not connected:{" "}
          {idle.map((d) => d.netdev ?? d.name).join(", ")}
        </p>
      )}
    </Panel>
  );
}
