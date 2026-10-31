import type { ReactNode } from "react";

/*
 * Row primitives in the Settings dialog look (`.set-row`): text on the left,
 * control on the right. Used by the Alerts dialog and the browser alert
 * settings so they match the rest of Settings.
 */

interface RowProps {
  title: string;
  help?: ReactNode;
  /** id of the control; renders the title as its <label>. */
  htmlFor?: string;
  /** Put the control under the text, for wide controls or inline messages. */
  stack?: boolean;
  children: ReactNode;
}

export function SettingRow({ title, help, htmlFor, stack, children }: RowProps) {
  const heading = htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span className="set-row__title">{title}</span>;
  return (
    <div className={stack ? "set-row set-row--stack" : "set-row"}>
      <div className="set-row__text">
        {heading}
        {help ? <small>{help}</small> : null}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  );
}

/** The on/off switch used across Settings (`.toggle-track` / `.toggle-dot`). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  const track = "toggle-track relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const dot = "toggle-dot inline-block h-4 w-4 transform rounded-full shadow transition-transform";
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={checked ? `${track} is-on` : track}
      onClick={() => onChange(!checked)}
    >
      <span className={`${dot} ${checked ? "translate-x-4" : "translate-x-0"}`} />
    </button>
  );
}

interface ToggleRowProps {
  title: string;
  help?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Switch name when `title` is not specific enough (defaults to the title). */
  label?: string;
  /** Controls placed before the switch, e.g. a wait field. */
  children?: ReactNode;
}

export function ToggleRow({ title, help, checked, onChange, disabled = false, label, children }: ToggleRowProps) {
  return (
    <SettingRow title={title} help={help}>
      {children}
      <Switch checked={checked} onChange={onChange} label={label ?? title} disabled={disabled} />
    </SettingRow>
  );
}
