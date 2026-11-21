/**
 * The word count rule editor (WP27), the custom control of two settings
 * rows: the project's rule (`wordcount.rule`, shared with co-authors) and
 * the account's default (the account preference `wordcount.rule`, used by
 * every project without a rule of its own). Both store the sparse form.
 */
import { useEffect, useState } from 'react';
import { apiRequest } from '../../api';
import type { AccountPrefsResponse, CustomControlProps } from '../../settings/types';
import {
  DEFAULT_PATTERNS, KINDS, KIND_LABELS, PART_LABELS, PATTERN_LISTS, PRESETS, PRESET_IDS, resolveRule,
  type PatternList, type PresetId, type WordCountRule,
} from '../../wordcount/engine';
import { COUNTABLE_PARTS, sparseRule, withKind, withPart, withPreset } from './model';
import { RULE_SETTING, refreshWordCount } from './store';
import { ruleProblem, type StoredRule } from './validate';
import './wordcount.css';

const PATTERN_LABELS: Record<PatternList, string> = {
  supplementaryHeadings: 'Headings that start supplementary material',
  supplementaryEnvironments: 'Environments that hold supplementary material',
  supplementaryCommands: 'Commands that start supplementary material',
  supplementaryFiles: 'Included files that hold supplementary material',
  statementHeadings: 'Headings of statements (acknowledgments, declarations)',
  appendixHeadings: 'Headings that start the appendices',
  referenceHeadings: 'Headings of the reference list',
  ignoredEnvironments: 'Environments never counted',
};

interface EditorProps {
  value: StoredRule | null;
  onChange(v: StoredRule | null): void;
  disabled: boolean;
  /** What "no rule here" means: "Your default (Main text)" or "Built-in (Main text)". */
  inheritLabel: string;
  testId: string;
}

function NumberField({ value, onCommit, disabled, testId, label }: { value: number | null; onCommit(v: number | null): void; disabled: boolean; testId: string; label: string }) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => { setText(value == null ? '' : String(value)); }, [value]);
  const commit = () => {
    const t = text.trim().replace(/[,\s]/g, '');
    if (!t) { if (value != null) onCommit(null); return; }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= 1_000_000) { if (n !== value) onCommit(n); }
    else setText(value == null ? '' : String(value));
  };
  return (
    <label className="wc-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="numeric"
        placeholder="None"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        data-testid={testId}
      />
    </label>
  );
}

function PatternField({ list, rule, onRule, disabled, testId }: { list: PatternList; rule: WordCountRule; onRule(r: WordCountRule): void; disabled: boolean; testId: string }) {
  const joined = rule.patterns[list].join('\n');
  const [text, setText] = useState(joined);
  useEffect(() => { setText(joined); }, [joined]);
  const commit = () => {
    const next = text.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 50).map((s) => s.slice(0, 100));
    if (next.join('\n') !== joined) onRule({ ...rule, patterns: { ...rule.patterns, [list]: next } });
  };
  return (
    <label className="wc-field wc-field--patterns">
      <span>{PATTERN_LABELS[list]}</span>
      <textarea rows={3} value={text} disabled={disabled} onChange={(e) => setText(e.target.value)} onBlur={commit} data-testid={`${testId}-patterns-${list}`} />
      <button type="button" className="wc-link" disabled={disabled} onClick={() => onRule({ ...rule, patterns: { ...rule.patterns, [list]: [...DEFAULT_PATTERNS[list]] } })}>Reset</button>
    </label>
  );
}

/** The editor itself, for either row. */
export function RuleEditorView({ value, onChange, disabled, inheritLabel, testId }: EditorProps) {
  const rule = value ? resolveRule(value) : null;
  const set = (r: WordCountRule) => {
    const stored = sparseRule(r);
    if (ruleProblem(stored) === null) onChange(stored);
  };
  const choose = (preset: string) => {
    if (preset === '') onChange(null);
    else set(withPreset(rule ?? resolveRule(null), preset as PresetId));
  };
  return (
    <div className="wc-editor" data-testid={testId}>
      <label className="wc-field">
        <span>Rule</span>
        <select value={rule ? rule.preset : ''} disabled={disabled} onChange={(e) => choose(e.target.value)} data-testid={`${testId}-preset`}>
          <option value="">{inheritLabel}</option>
          {PRESET_IDS.map((id) => <option key={id} value={id}>{id === 'custom' ? 'Custom' : PRESETS[id].label}</option>)}
        </select>
      </label>
      {rule && (
        <>
          <fieldset className="wc-fieldset" disabled={disabled}>
            <legend>Count toward the total</legend>
            <div className="wc-checks">
              {COUNTABLE_PARTS.map((p) => (
                <label key={p}><input type="checkbox" checked={rule.parts.includes(p)} onChange={(e) => set(withPart(rule, p, e.target.checked))} data-testid={`${testId}-part-${p}`} /> {PART_LABELS[p]}</label>
              ))}
            </div>
            <div className="wc-checks">
              {KINDS.map((k) => (
                <label key={k}><input type="checkbox" checked={rule.kinds.includes(k)} onChange={(e) => set(withKind(rule, k, e.target.checked))} data-testid={`${testId}-kind-${k}`} /> {KIND_LABELS[k]}</label>
              ))}
            </div>
            <label className="wc-field">
              <span>Formulas count as</span>
              <select value={rule.formulas} onChange={(e) => set({ ...rule, formulas: e.target.value === 'one-word' ? 'one-word' : 'none' })} data-testid={`${testId}-formulas`}>
                <option value="none">Nothing</option>
                <option value="one-word">One word each</option>
              </select>
            </label>
          </fieldset>
          <div className="wc-numbers">
            <NumberField label="Target" value={rule.target} disabled={disabled} onCommit={(n) => set({ ...rule, target: n })} testId={`${testId}-target`} />
            <NumberField label="Abstract limit" value={rule.abstractLimit} disabled={disabled} onCommit={(n) => set({ ...rule, abstractLimit: n })} testId={`${testId}-abstract`} />
          </div>
          <label className="wc-field wc-field--switch">
            <input type="checkbox" role="switch" checked={rule.detect} disabled={disabled} onChange={(e) => set({ ...rule, detect: e.target.checked })} data-testid={`${testId}-detect`} />
            <span>Find supplementary material, statements and appendices automatically</span>
          </label>
          {Object.keys(rule.sections).length > 0 && (
            <div className="wc-fieldset">
              <div className="wc-legend">Sections counted differently</div>
              {Object.entries(rule.sections).map(([title, part]) => (
                <div key={title} className="wc-override">
                  <span>{title}: {PART_LABELS[part]}</span>
                  <button
                    type="button"
                    className="wc-link"
                    disabled={disabled}
                    onClick={() => { const sections = { ...rule.sections }; delete sections[title]; set({ ...rule, sections }); }}
                    data-testid={`${testId}-section-remove`}
                  >Remove</button>
                </div>
              ))}
            </div>
          )}
          <details className="wc-details">
            <summary>Edit patterns</summary>
            <p className="wc-help">One pattern per line. <code>*</code> matches any run of characters and <code>?</code> one character; case is ignored, and a pattern matches the whole heading title or file path.</p>
            {PATTERN_LISTS.map((list) => <PatternField key={list} list={list} rule={rule} onRule={set} disabled={disabled} testId={testId} />)}
          </details>
        </>
      )}
    </div>
  );
}

/** The project's rule: the settings page binds the value to the project setting. */
export function ProjectRuleControl({ value, onChange, disabled }: CustomControlProps<StoredRule | null>) {
  return <RuleEditorView value={value} onChange={onChange} disabled={disabled} inheritLabel="Your default" testId="wc-project-rule" />;
}

const PREFS_URL = '/api/account/preferences';

/**
 * The account's default rule. The project setting already holds the id
 * `wordcount.rule` in the registry, so this row (`wordcount.accountRule`)
 * reads and writes the account preference `wordcount.rule` itself, which is
 * what the server reads for a project without a rule.
 */
export function AccountRuleControl({ disabled }: CustomControlProps<null>) {
  const [value, setValue] = useState<StoredRule | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    apiRequest<AccountPrefsResponse>(PREFS_URL).then(
      (r) => { if (live) { const v = r.prefs?.[RULE_SETTING]; setValue(v && typeof v === 'object' && ruleProblem(v) === null ? (v as StoredRule) : null); } },
      () => { if (live) { setValue(null); setError('Your account’s preferences could not be read.'); } },
    );
    return () => { live = false; };
  }, []);
  if (value === undefined) return <span className="settings__hint">Loading…</span>;
  const save = (v: StoredRule | null) => {
    const before = value;
    setValue(v);
    setError(null);
    const body = v ? { set: { [RULE_SETTING]: v } } : { unset: [RULE_SETTING] };
    apiRequest<AccountPrefsResponse>(PREFS_URL, { method: 'PATCH', body: JSON.stringify(body) }).then(
      () => { void refreshWordCount(); },
      (err: Error) => { setValue(before); setError(`Not saved: ${err.message}`); },
    );
  };
  return (
    <>
      <RuleEditorView value={value} onChange={save} disabled={disabled} inheritLabel="Built-in (Main text)" testId="wc-account-rule" />
      {error && <span className="settings__hint" role="alert">{error}</span>}
    </>
  );
}
