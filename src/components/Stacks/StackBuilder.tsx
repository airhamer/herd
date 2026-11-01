import { useState } from "react";

/**
 * SC5a (#72) "New stack" form. Pick components, name the stack, and save it
 * to the dashboard's config/stacks.json (POST /api/stacks, decision #5).
 * The category is computed by the server, never chosen here.
 */
export function StackBuilder({
  components,
  onSave,
  onCancel,
}: {
  components: { id: string; name: string }[];
  onSave: (stack: { name: string; componentNames: string[] }) => Promise<void>;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: name.trim(), componentNames: selected });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-accent/40 bg-surface-elevated p-3 text-xs" data-testid="stack-builder">
      <h3 className="panel-title mb-2">New stack</h3>
      <input
        aria-label="Stack name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Stack name"
        className="mb-2 w-full rounded border border-border bg-surface px-2 py-1 text-xs text-text"
      />
      <div className="flex flex-col gap-1">
        {components.map((c) => (
          <label key={c.id} className="flex items-center gap-2">
            <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
            <span className="text-text">{c.name}</span>
            <span className="font-mono text-[10px] text-muted">{c.id}</span>
          </label>
        ))}
      </div>
      {error && <div className="mt-2 text-danger">{error}</div>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || !name.trim() || selected.length === 0}
          onClick={() => void save()}
          className="rounded border border-accent/50 bg-accent-soft px-2 py-0.5 text-accent disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save stack"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-border px-2 py-0.5 text-muted">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default StackBuilder;
