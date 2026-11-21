/**
 * The settings page's generic controls, one per `Control` kind
 * (settings/types.ts). Each takes the row's value and reports a new one
 * through `onChange`, which answers false when the definition's validate()
 * refused it; nothing here reads or writes storage.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type LazyExoticComponent } from 'react';
import type { AnySettingDef, Control, CustomControlProps } from '../../settings/types';
import { controlKind, optionFor, parseNumber, snapToStep, toggleChecklist } from './model';

export interface ControlProps {
  def: AnySettingDef;
  value: unknown;
  /** False when the value was refused (the definition's validate()). */
  onChange(v: unknown): boolean;
  disabled: boolean;
  /** DOM ids: the control (for `<label for>`), its label and its hint. */
  id: string;
  labelId: string;
  hintId?: string;
  testId: string;
}

type Options = { value: string | number; label: string }[];

export function SettingControl(p: ControlProps) {
  const c = p.def.control;
  switch (controlKind(p.def)) {
    case 'switch': return <SwitchControl {...p} />;
    case 'segmented': return <SegmentedControl {...p} options={(c as { options: Options }).options} />;
    case 'select': return <SelectControl {...p} options={(c as { options: Options }).options} />;
    case 'slider': return <SliderControl {...p} control={c as Extract<Control, { kind: 'slider' }>} />;
    case 'text': return <TextControl {...p} />;
    case 'number': return <NumberControl {...p} control={c as Extract<Control, { kind: 'text' | 'number' }>} />;
    case 'checklist': return <ChecklistControl {...p} options={(c as Extract<Control, { kind: 'checklist' }>).options} />;
    case 'custom': return <CustomControl {...p} control={c as Extract<Control, { kind: 'custom' }>} />;
    default: return null;
  }
}

function SwitchControl({ value, onChange, disabled, id, hintId, testId }: ControlProps) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      checked={value === true}
      onChange={(e) => onChange(e.target.checked)}
      disabled={disabled}
      aria-describedby={hintId}
      data-testid={testId}
    />
  );
}

/** A radio group: one tab stop, arrows move and choose, as native radios do. */
function SegmentedControl({ value, onChange, disabled, labelId, hintId, testId, options }: ControlProps & { options: Options }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = options.findIndex((o) => String(o.value) === String(value));
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = options.length - 1;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i === last ? 0 : i + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i === 0 ? last : i - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    refs.current[to]?.focus();
    onChange(options[to].value);
  };
  return (
    <div className="settings-segmented" role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId} aria-disabled={disabled || undefined} data-testid={testId}>
      {options.map((o, i) => {
        const on = i === at;
        return (
          <button
            key={String(o.value)}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (at < 0 && i === 0) ? 0 : -1}
            className={`settings-segmented__item${on ? ' is-on' : ''}`}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            data-testid={`${testId}-${String(o.value) || 'default'}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SelectControl({ value, onChange, disabled, id, hintId, testId, options }: ControlProps & { options: Options }) {
  return (
    <select
      id={id}
      className="input"
      value={String(value ?? '')}
      onChange={(e) => { const v = optionFor(options, e.target.value); if (v !== undefined) onChange(v); }}
      disabled={disabled}
      aria-describedby={hintId}
      data-testid={testId}
    >
      {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
    </select>
  );
}

/**
 * A field that saves on Enter, on blur and when it unmounts (Escape closes
 * the page without a blur), and shows the stored value again when the text
 * was refused. `parse` returns undefined for text that is not a value.
 */
function useCommittedField(value: unknown, show: (v: unknown) => string, parse: (raw: string) => unknown, onChange: (v: unknown) => boolean) {
  const [text, setText] = useState(() => show(value));
  const [refused, setRefused] = useState(false);
  const shown = show(value);
  useEffect(() => { setText(shown); setRefused(false); }, [shown]);
  const commit = () => {
    if (text === shown) { setRefused(false); return; }
    const next = parse(text);
    const ok = next !== undefined && onChange(next);
    setRefused(!ok);
    if (!ok) setText(shown);
  };
  const latest = useRef(commit);
  latest.current = commit;
  useEffect(() => () => latest.current(), []);
  return {
    text,
    refused,
    bind: {
      value: text,
      onChange: (e: { target: { value: string } }) => { setText(e.target.value); setRefused(false); },
      onBlur: () => commit(),
      onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } },
    },
  };
}

function SliderControl({ def, value, onChange, disabled, id, hintId, testId, control }: ControlProps & { control: Extract<Control, { kind: 'slider' }> }) {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : (def.default as number);
  const field = useCommittedField(num, (v) => String(v), (raw) => { const n = parseNumber(raw); return n === null ? undefined : snapToStep(n, control); }, onChange);
  return (
    <span className="settings-slider">
      <input
        id={id}
        type="range"
        min={control.min}
        max={control.max}
        step={control.step}
        value={num}
        onChange={(e) => onChange(Number(e.target.value))}
        disabled={disabled}
        aria-describedby={hintId}
        aria-valuetext={control.unit ? `${num} ${control.unit}` : undefined}
        data-testid={testId}
      />
      <input
        className="input settings-slider__number"
        type="text"
        inputMode="decimal"
        {...field.bind}
        disabled={disabled}
        aria-label={`${def.label}${control.unit ? ` in ${control.unit}` : ''}`}
        aria-invalid={field.refused || undefined}
        data-testid={`${testId}-number`}
      />
      {control.unit && <span className="settings-slider__unit" aria-hidden="true">{control.unit}</span>}
    </span>
  );
}

function TextControl({ value, onChange, disabled, id, hintId, testId }: ControlProps) {
  const field = useCommittedField(value, (v) => (typeof v === 'string' ? v : ''), (raw) => raw, onChange);
  return (
    <input
      id={id}
      className="input"
      type="text"
      {...field.bind}
      disabled={disabled}
      aria-describedby={hintId}
      aria-invalid={field.refused || undefined}
      spellCheck={false}
      autoComplete="off"
      data-testid={testId}
    />
  );
}

function NumberControl({ value, onChange, disabled, id, hintId, testId, control }: ControlProps & { control: Extract<Control, { kind: 'text' | 'number' }> }) {
  const field = useCommittedField(value, (v) => (typeof v === 'number' ? String(v) : ''), (raw) => {
    const n = parseNumber(raw);
    if (n === null) return undefined;
    return Math.min(control.max ?? Infinity, Math.max(control.min ?? -Infinity, n));
  }, onChange);
  return (
    <input
      id={id}
      className="input"
      type="text"
      inputMode="decimal"
      {...field.bind}
      disabled={disabled}
      aria-describedby={hintId}
      aria-invalid={field.refused || undefined}
      data-testid={testId}
    />
  );
}

function ChecklistControl({ value, onChange, disabled, labelId, hintId, testId, options }: ControlProps & { options: { value: string; label: string }[] }) {
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  return (
    <div className="settings-checklist" role="group" aria-labelledby={labelId} aria-describedby={hintId} data-testid={testId}>
      {options.map((o) => (
        <label key={o.value} className="settings-checklist__item">
          <input
            type="checkbox"
            checked={chosen.includes(o.value)}
            onChange={(e) => onChange(toggleChecklist(options, chosen, o.value, e.target.checked))}
            disabled={disabled}
            data-testid={`${testId}-${o.value}`}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}

type CustomComponent = ComponentType<CustomControlProps<any>>;
// One lazy component per control definition: a new lazy() on every render would remount it.
const customControls = new WeakMap<object, LazyExoticComponent<CustomComponent>>();

function customFor(control: Extract<Control, { kind: 'custom' }>): LazyExoticComponent<CustomComponent> {
  let C = customControls.get(control);
  if (!C) {
    C = lazy(control.load);
    customControls.set(control, C);
  }
  return C;
}

function CustomControl({ def, value, onChange, disabled, labelId, testId, control }: ControlProps & { control: Extract<Control, { kind: 'custom' }> }) {
  const C = customFor(control);
  return (
    <div className="settings-custom" role="group" aria-labelledby={labelId} data-testid={testId}>
      <Suspense fallback={<span className="settings__hint">Loading…</span>}>
        <C def={def} value={value} onChange={(v: unknown) => { onChange(v); }} disabled={disabled} />
      </Suspense>
    </div>
  );
}
