import React, { useState } from 'react';

// Basic stub for Stack builder / selector
// Will be wired to live component list from telemetry + calculator
// Categories: proven | calculated | not_recommended | blocked

export type StackCategory = 'proven' | 'calculated' | 'not_recommended' | 'blocked';

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
        Category: <span className="font-mono">{currentCategory}</span> (live calc coming)
      </div>
      <button onClick={save} className="btn">Save Stack</button>
      <div className="text-xs text-muted mt-2">Proven = history success • Calculated = resource math • etc.</div>
    </div>
  );
};

export default StackBuilder;