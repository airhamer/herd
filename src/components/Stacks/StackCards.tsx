import type { ReactNode } from "react";
import { STACK_CATEGORY_LABELS, type StackCategory } from "../../../shared/types";
import type { FleetStack } from "../../api/client";

type NamesById = Record<string, string>;

const BADGE: Record<StackCategory, string> = {
  proven: "border-success/60 text-success",
  calculated: "border-accent/60 text-accent",
  not_recommended: "border-warning/60 text-warning",
  blocked: "border-danger/60 text-danger",
};

/** The SC1 category label as a small badge. */
export function CategoryBadge({ category }: { category: string }) {
  const c = (category in BADGE ? category : "calculated") as StackCategory;
  return (
    <span
      data-testid="category-badge"
      className={`rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${BADGE[c]}`}
    >
      {STACK_CATEGORY_LABELS[c]}
    </span>
  );
}

/** Where a stack lands, in node names. */
export function targetLabel(s: FleetStack, names: NamesById): string {
  if (!s.target.nodeIds.length) return "no fleet nodes yet";
  const who = s.target.nodeIds.map((n) => names[n] ?? n).join(" + ");
  return s.target.groupId ? `${s.target.groupId}: ${who}` : who;
}

/**
 * SC5a stack cards. There is one card per stack and landing target, each
 * with its category badge and reason. Clicking a card filters the component
 * list to its members.
 */
export function StackCards({
  stacks,
  hiddenBlocked,
  nodeNames,
  selected,
  onSelect,
  extra,
}: {
  stacks: FleetStack[];
  /** Blocked cards hidden by the "show blocked" toggle. */
  hiddenBlocked: number;
  nodeNames: NamesById;
  selected: string;
  onSelect: (id: string) => void;
  /** Per-card slot for later slices (SC5b preview). */
  extra?: (s: FleetStack) => ReactNode;
}) {
  const ids = new Set(stacks.map((s) => s.id));
  return (
    <div className="mb-3 rounded-lg border border-border bg-surface-elevated p-3">
      <h3 className="panel-title mb-2">
        Stacks ({ids.size})
        {hiddenBlocked > 0 && (
          <span className="ml-2 text-[10px] font-normal normal-case text-muted">{hiddenBlocked} blocked hidden</span>
        )}
      </h3>
      {stacks.length === 0 ? (
        <p className="text-xs text-muted">No stacks match the filters.</p>
      ) : (
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))" }}>
          {stacks.map((s) => {
            const key = `${s.id}|${s.target.groupId ?? ""}|${s.target.nodeIds.join(",")}`;
            const active = selected === s.id;
            return (
              <div
                key={key}
                data-testid={`stack-card-${s.id}`}
                className={`flex flex-col gap-1 rounded border p-2 text-xs transition-colors ${
                  active ? "border-accent/60 bg-accent-soft" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(active ? "all" : s.id)}
                  className="flex flex-wrap items-baseline gap-2 text-left"
                  title={active ? "Show all components" : "Show only this stack's components"}
                >
                  <span className="font-semibold text-text-strong">{s.name}</span>
                  <span className="ml-auto">
                    <CategoryBadge category={s.category} />
                  </span>
                </button>
                <div className="text-[10px] uppercase tracking-wide text-muted">
                  tp{s.tp} · {targetLabel(s, nodeNames)}
                </div>
                <div className="text-[11px] text-muted" data-testid="category-reason">
                  {s.categoryReason}
                </div>
                <div className="flex flex-wrap gap-1">
                  {s.componentNames.map((c) => (
                    <span key={c} className="rounded bg-surface px-1 font-mono text-[10px] text-muted">
                      {c}
                    </span>
                  ))}
                </div>
                {extra?.(s)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
