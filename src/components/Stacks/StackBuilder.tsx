import React, { useState } from 'react';
import type { StackCategory } from "../../../shared/types";
import { STACK_CATEGORY_LABELS } from "../../../shared/types";

// Stack builder / selector stub.
// Will be wired to live component list from telemetry + calculator.
// SC1 terminology: Stack = group of Components; categories are
// Proven / Calculated / Not recommended / Blocked (labels from
// shared/types STACK_CATEGORY_LABELS). StackBuilder is a stub, unwired
// until SC5 — its UI copy is the only consumer of the labels today.

export type { StackCategory };

interface ComponentItem {
  name: string;
  footprintMB: number;
}

interface StackBuilderProps {
  availableComponents: ComponentItem[];
  onSaveStack: (stack: { name: string; componentNames: string[] }) => void;
}

export const StackBuilder: React.FC<StackBuilderProps> = ({ availableComponents, onSaveStack }) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [stackName, setStackName] = useState('');

  // TODO: call backend / local calculator for live category
  const currentCategory: StackCategory = selected.length > 0 ? 'calculated' : 'proven'; // placeholder

  const toggle = (name: string) => {
    setSelected(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
  };

  const save = () => {
    if (!stackName || selected.length === 0) return;
    onSaveStack({ name: stackName, componentNames: selected });
    setSelected([]);
    setStackName('');
  };

  return (
    <div className="p-4 border rounded bg-surface">
      <h3 className="font-semibold mb-2">Define Stack (Components)</h3>
      <input
        className="input mb-2"
        placeholder="Stack name e.g. Qwen3.8 + Flash"
        value={stackName}
        onChange={e => setStackName(e.target.value)}
      />
      <div className="mb-2">
        {availableComponents.map(c => (
          <label key={c.name} className="block">
            <input type="checkbox" checked={selected.includes(c.name)} onChange={() => toggle(c.name)} />
            {' '}{c.name} ({c.footprintMB} MB)
          </label>
        ))}
      </div>
      <div className="mb-2">
        Category: <span className="font-mono">{STACK_CATEGORY_LABELS[currentCategory]}</span> (live calc coming)
      </div>
      <button onClick={save} className="btn">Save Stack</button>
      <div className="text-xs text-muted mt-2">
        {STACK_CATEGORY_LABELS.proven} = history success • {STACK_CATEGORY_LABELS.calculated} = resource math •
        {' '}{STACK_CATEGORY_LABELS.not_recommended} = tight fit • {STACK_CATEGORY_LABELS.blocked} = insufficient resources
      </div>
    </div>
  );
};

export default StackBuilder;