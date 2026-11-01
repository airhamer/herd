import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  addFleetNode,
  deleteFleetNode,
  updateFleetNode,
} from "../../api/client";
import type { NodeRecord, NodeLink } from "../../api/client";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useFocusTrap } from "../../hooks/useFocusTrap";

interface ManageNodesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful add/update/delete so the parent can refresh. */
  onChanged?: () => void;
  /** GRP1: open the Topology tab, where spark groups are edited. */
  onOpenTopology?: () => void;
}

/** One-line summary of a node's resolved spark group (config/groups.json). */
export function groupSummary(n: Pick<NodeRecord, "role" | "rank" | "groupId" | "groupName">): string {
  if (!n.groupId) return "Standalone";
  const role = n.role === "head" ? "head" : n.role === "worker" ? "worker" : n.role;
  return `${n.groupName || n.groupId} · ${role}${n.rank != null ? ` · rank ${n.rank}` : ""}`;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);
}

const emptyNode = (): NodeRecord => ({
  id: "",
  name: "",
  endpoint: "",
  lanIp: "",
  role: "standalone",
  rank: null,
  groupId: null,
  headId: null,
  links: [],
  agentPort: 30091,
  isLocal: false,
});

function emptyLink(): NodeLink {
  return {
    from: "",
    to: "",
    fromIf: null,
    toIf: null,
    speedMbps: null,
    transport: "roce",
    up: true,
  };
}

const inputCls =
  "w-full rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-text outline-none focus:border-accent";
const labelCls = "mb-1 block text-xs text-muted";

/**
 * ManageNodesDialog — read/write the fleet node registry (config/nodes.json)
 * from the UI. Add, edit, and remove nodes; configure RoCE links. Mirrors
 * the AddSparkDialog / EditSparkDialog patterns.
 *
 * GRP1 (#82): a node's spark group (role / rank / groupId / headId) is shown
 * read-only — it is the resolved value from config/groups.json, edited on the
 * Topology tab — and is never sent on save, so the two cannot diverge.
 */
export function ManageNodesDialog({ open, onClose, onChanged, onOpenTopology }: ManageNodesDialogProps) {
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<NodeRecord | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscape(onClose);

  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);

  // Load the registry when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchNodes()
      .then((res) => {
        if (cancelled) return;
        setNodes(res.nodes);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  function fetchNodes() {
    return import("../../api/client").then((m) => m.fetchFleetNodes());
  }

  const update = (patch: Partial<NodeRecord>) => {
    setEditing((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const updateLink = (idx: number, patch: Partial<NodeLink>) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const links = prev.links.map((l, i) => (i === idx ? { ...l, ...patch } : l));
      return { ...prev, links };
    });
  };

  const addLink = () => {
    setEditing((prev) =>
      prev ? { ...prev, links: [...prev.links, emptyLink()] } : prev
    );
  };

  const removeLink = (idx: number) => {
    setEditing((prev) =>
      prev
        ? { ...prev, links: prev.links.filter((_, i) => i !== idx) }
        : prev
    );
  };

  const startNew = () => {
    setEditing(emptyNode());
    setIsNew(true);
    setError(null);
  };

  const startEdit = (node: NodeRecord) => {
    setEditing(JSON.parse(JSON.stringify(node)));
    setIsNew(false);
    setError(null);
  };

  const handleSave = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await addFleetNode(editing);
      } else {
        await updateFleetNode(editing.id, editing);
      }
      const res = await fetchNodes();
      setNodes(res.nodes);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await deleteFleetNode(editing.id);
      const res = await fetchNodes();
      setNodes(res.nodes);
      onChanged?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={trapRef}
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-nodes-title"
      >
        <div className="modal-sheet__header" id="manage-nodes-title">
          Manage Nodes
          <button
            type="button"
            onClick={onClose}
            className="icon-circle ml-auto"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal-sheet__body">
          {loading && <p className="text-xs text-muted">Loading nodes…</p>}

          {!loading && (
            <div className="space-y-3">
              {/* Node list */}
              <div>
                <div className="flex items-center justify-between">
                  <h3 className="panel-title mb-2">Registered nodes</h3>
                  <button
                    type="button"
                    onClick={startNew}
                    className="rounded border border-border bg-surface-elevated px-2.5 py-1 text-xs text-muted hover:bg-surface-hover"
                  >
                    + Add node
                  </button>
                </div>
                {nodes.length === 0 ? (
                  <p className="text-xs text-muted">
                    No nodes registered. Add one above, or edit
                    config/nodes.json on the dashboard host.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {nodes.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => startEdit(n)}
                        className="w-full rounded border border-border bg-surface-elevated px-3 py-2 text-left text-xs text-text hover:border-accent"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-text-strong">{n.name || n.id}</span>
                          <span className="text-muted">
                            {groupSummary(n)}
                            {n.status === "pending" ? " · pending" : ""}
                          </span>
                        </div>
                        <div className="mt-0.5 font-tabular text-muted">
                          {n.id} · {n.lanIp} · {n.links.length} link
                          {n.links.length === 1 ? "" : "s"}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Edit / new form */}
              {editing && (
                <div className="rounded border border-border bg-surface p-3">
                  <h3 className="panel-title mb-2">
                    {isNew ? "New node" : `Edit ${editing.id}`}
                  </h3>
                  {/* S1.2 enroll UI: a pending node shows its one-time claim token. */}
                  {editing.status === "pending" && editing.claimToken && (
                    <div className="mb-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-[11px]">
                      <p className="mb-1 text-warning">Pending enrollment — one-time claim token:</p>
                      <code className="break-all font-tabular">{editing.claimToken}</code>
                      <p className="mt-1 text-muted">
                        Pass it to the node's install script, or simply wait: the
                        first successful poll claims the node automatically.
                      </p>
                    </div>
                  )}
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>
                          ID {isNew ? "(required)" : "(read-only)"}
                        </label>
                        <input
                          type="text"
                          value={editing.id}
                          readOnly={!isNew}
                          onChange={(e) => update({ id: e.target.value })}
                          className={inputCls}
                          placeholder="gx10-1c2c"
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Name</label>
                        <input
                          type="text"
                          value={editing.name}
                          onChange={(e) => update({ name: e.target.value })}
                          className={inputCls}
                          placeholder="GX10 (1c2c)"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>LAN IP</label>
                        <input
                          type="text"
                          value={editing.lanIp}
                          onChange={(e) => update({ lanIp: e.target.value })}
                          className={inputCls}
                          placeholder="192.168.50.226"
                        />
                      </div>
                      <div>
                        <label className={labelCls}>Endpoint</label>
                        <input
                          type="text"
                          value={editing.endpoint}
                          onChange={(e) => update({ endpoint: e.target.value })}
                          className={inputCls}
                          placeholder="192.168.50.226:30091"
                        />
                        <p className="mt-1 text-[10px] text-muted">
                          Node-agent HTTP endpoint (ip:port). Leave blank to
                          derive from LAN IP + agent port.
                        </p>
                      </div>
                    </div>

                    <div
                      className="rounded border border-border bg-surface px-3 py-2"
                      data-testid="manage-node-group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={labelCls + " mb-0"}>Spark group</span>
                        <span className="text-xs text-text" data-testid="manage-node-group-summary">
                          {isNew ? "Standalone" : groupSummary(editing)}
                        </span>
                      </div>
                      {!isNew && editing.headId ? (
                        <p className="mt-1 text-[10px] text-muted">Head: {editing.headId}</p>
                      ) : null}
                      <p className="mt-1 text-[10px] text-muted">
                        Groups, roles and ranks are edited on the{" "}
                        {onOpenTopology ? (
                          <button
                            type="button"
                            className="text-accent underline"
                            data-testid="manage-node-open-topology"
                            onClick={() => {
                              onClose();
                              onOpenTopology();
                            }}
                          >
                            Topology tab
                          </button>
                        ) : (
                          "Topology tab"
                        )}
                        .
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className={labelCls}>Agent port</label>
                        <input
                          type="number"
                          value={editing.agentPort}
                          onChange={(e) =>
                            update({
                              agentPort: parseInt(e.target.value, 10) || 30091,
                            })
                          }
                          className={inputCls}
                        />
                      </div>
                      <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={editing.isLocal}
                          onChange={(e) => update({ isLocal: e.target.checked })}
                          className="rounded border-border"
                        />
                        This host (local)
                      </label>
                    </div>

                    {/* Links */}
                    <div>
                      <div className="flex items-center justify-between">
                        <label className={labelCls} style={{ marginBottom: 0 }}>
                          RoCE links
                        </label>
                        <button
                          type="button"
                          onClick={addLink}
                          className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[11px] text-muted hover:bg-surface-hover"
                        >
                          + Add link
                        </button>
                      </div>
                      {editing.links.length === 0 && (
                        <p className="mt-1 text-[10px] text-muted">
                          No links. Add a link for each RoCE/transport
                          connection to this node.
                        </p>
                      )}
                      <div className="mt-1.5 space-y-2">
                        {editing.links.map((link, idx) => (
                          <div
                            key={idx}
                            className="rounded border border-border bg-surface-elevated p-2"
                          >
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <label className={labelCls}>From</label>
                                <input
                                  type="text"
                                  value={link.from}
                                  onChange={(e) =>
                                    updateLink(idx, { from: e.target.value })
                                  }
                                  className={inputCls}
                                  placeholder={editing.id}
                                />
                              </div>
                              <div>
                                <label className={labelCls}>To</label>
                                <input
                                  type="text"
                                  value={link.to}
                                  onChange={(e) =>
                                    updateLink(idx, { to: e.target.value })
                                  }
                                  className={inputCls}
                                  placeholder="gx10-25ed"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2 mt-2">
                              <div>
                                <label className={labelCls}>From interface</label>
                                <input
                                  type="text"
                                  value={link.fromIf ?? ""}
                                  onChange={(e) =>
                                    updateLink(idx, { fromIf: e.target.value || null })
                                  }
                                  className={inputCls}
                                  placeholder="enp1s0f1np1"
                                />
                              </div>
                              <div>
                                <label className={labelCls}>To interface</label>
                                <input
                                  type="text"
                                  value={link.toIf ?? ""}
                                  onChange={(e) =>
                                    updateLink(idx, { toIf: e.target.value || null })
                                  }
                                  className={inputCls}
                                  placeholder="enp1s0f0np0"
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-3 gap-2 mt-2">
                              <div>
                                <label className={labelCls}>Speed (Mbps)</label>
                                <input
                                  type="number"
                                  value={link.speedMbps ?? ""}
                                  onChange={(e) =>
                                    updateLink(idx, {
                                      speedMbps:
                                        e.target.value === ""
                                          ? null
                                          : parseInt(e.target.value, 10),
                                    })
                                  }
                                  className={inputCls}
                                  placeholder="200000"
                                />
                              </div>
                              <div>
                                <label className={labelCls}>Transport</label>
                                <select
                                  value={link.transport}
                                  onChange={(e) =>
                                    updateLink(idx, {
                                      transport: e.target.value as "roce" | "tcp",
                                    })
                                  }
                                  className={inputCls}
                                >
                                  <option value="roce">roce</option>
                                  <option value="tcp">tcp</option>
                                </select>
                              </div>
                              <label className="flex items-end gap-2 pb-2 text-xs text-muted">
                                <input
                                  type="checkbox"
                                  checked={link.up}
                                  onChange={(e) =>
                                    updateLink(idx, { up: e.target.checked })
                                  }
                                  className="rounded border-border"
                                />
                                Up
                              </label>
                            </div>
                            <div className="mt-1.5 text-right">
                              <button
                                type="button"
                                onClick={() => removeLink(idx)}
                                className="rounded border border-border bg-surface-elevated px-2 py-0.5 text-[11px] text-muted hover:bg-surface-hover"
                              >
                                Remove link
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded bg-danger/20 px-3 py-2 text-xs text-danger">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {editing && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving || isNew}
                className="rounded border border-border bg-surface-elevated px--3 py-1.5 text-xs text-muted hover:bg-surface-hover disabled:opacity-50"
              >
                {isNew ? "Cancel" : "Delete"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-border bg-surface-elevated px-3 py-1.5 text-xs text-muted hover:bg-surface-hover"
            >
              Close
            </button>
            {editing && (
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !editing.id}
                className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {saving ? "Saving…" : isNew ? "Add node" : "Save"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
);
}
