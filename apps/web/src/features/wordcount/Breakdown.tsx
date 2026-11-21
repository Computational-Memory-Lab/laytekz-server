/**
 * The word count breakdown (WP27), opened from the status button: what is
 * counted and why, by part, kind and section. Its checkboxes and "Count
 * as…" menus change the project's rule, so co-authors see the same count;
 * people who may only view see them read-only.
 */
import { useState, useSyncExternalStore } from 'react';
import { KINDS, KIND_LABELS, PART_LABELS, PRESETS, PRESET_IDS, type Kind, type Part, type PresetId, type WordCountRule } from '../../wordcount/engine';
import { useProjectSetting } from '../../settings/store';
import { useToast } from '../../components/Toast';
import type { EditorPageCtx } from '../types';
import {
  COUNTABLE_PARTS, COUNT_AS, breakdownText, fmt, ruleLabel, sectionOverride, sourceLabel, sparseRule,
  withKind, withPart, withPreset, withSection, words,
} from './model';
import { RULE_SETTING, previewRule, refreshWordCount, subscribeWordCount, wordCountSnapshot } from './store';
import type { StoredRule } from './validate';

export default function Breakdown({ page, onClose }: { page: EditorPageCtx; onClose(): void }) {
  const snap = useSyncExternalStore(subscribeWordCount, wordCountSnapshot, wordCountSnapshot);
  const [, setRule, { canEdit }] = useProjectSetting<StoredRule | null>(RULE_SETTING);
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const editable = canEdit && page.canEdit() && !page.showcase();
  const { breakdown: b, view: v, rule } = snap;

  const apply = (next: WordCountRule) => {
    const stored = sparseRule(next);
    previewRule(stored);
    setRule(stored).then(
      () => refreshWordCount(),
      (err: Error) => { toast(`The word count rule was not saved: ${err.message}`, 'error'); void refreshWordCount(); },
    );
  };
  const jump = (file: string, line: number) => { page.openFile(file, { line }); onClose(); };
  const settings = () => { onClose(); page.openSettings({ section: 'wordcount', setting: RULE_SETTING }); };

  if (!b || !v) {
    return (
      <div className="wc-pop">
        <div className="wc-pop__head">
          <div className="wc-pop__total">{snap.loading ? 'Counting…' : `This file: ${words(snap.total)}`}</div>
          {!snap.loading && <div className="wc-pop__rule">The project has no main document to count yet, so this is the open file on its own.</div>}
        </div>
        <div className="wc-pop__foot"><button type="button" className="wc-link" onClick={settings} data-testid="wc-settings">Word count settings…</button></div>
      </div>
    );
  }

  const copy = () => {
    const text = breakdownText(b, v, rule);
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => toast('Copying was refused by the browser.', 'error'));
  };
  const reasons = b.why.filter((w) => w.part !== 'main');
  const ignored = v.tally.ignored;
  const comments = v.tally.comments;
  const pct = v.target ? Math.min(100, Math.round((v.total / v.target.words) * 100)) : 0;

  return (
    <div className="wc-pop">
      <div className="wc-pop__head">
        <div className="wc-pop__total" data-testid="wc-total">Counted: {words(v.total)}</div>
        <div className="wc-pop__rule" data-testid="wc-rule">{ruleLabel(rule)} · {sourceLabel(b.ruleSource)}</div>
        <button type="button" className="wc-link" onClick={settings} data-testid="wc-settings">Word count settings…</button>
      </div>

      {v.target && (
        <div className={`wc-target${v.target.over ? ' wc-target--over' : ''}`} data-testid="wc-target">
          <div className="wc-target__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
          <span>{fmt(v.total)} / {words(v.target.words)}{v.target.over ? ` · ${words(v.target.over)} over` : ''}</span>
        </div>
      )}
      {v.abstract.limit && (
        <div className={`wc-target${v.abstract.words > v.abstract.limit ? ' wc-target--over' : ''}`} data-testid="wc-abstract">
          <span>Abstract {fmt(v.abstract.words)} / {fmt(v.abstract.limit)}</span>
        </div>
      )}

      <label className="wc-row wc-row--select">
        <span>Rule</span>
        <select value={rule.preset} disabled={!editable} onChange={(e) => apply(withPreset(rule, e.target.value as PresetId))} data-testid="wc-preset">
          {PRESET_IDS.map((id) => <option key={id} value={id}>{id === 'custom' ? 'Custom' : PRESETS[id].label}</option>)}
        </select>
      </label>

      <div className="wc-group" role="group" aria-label="Parts">
        <div className="wc-group__title">Parts</div>
        {COUNTABLE_PARTS.map((p: Part) => (
          <label key={p} className="wc-row">
            <input type="checkbox" checked={rule.parts.includes(p)} disabled={!editable} onChange={(e) => apply(withPart(rule, p, e.target.checked))} data-testid={`wc-part-${p}`} />
            <span className="wc-row__label">{PART_LABELS[p]}</span>
            <span className="wc-row__n">{fmt(v.parts[p])}</span>
          </label>
        ))}
        <div className="wc-row wc-row--muted" data-testid="wc-part-references">
          <input type="checkbox" checked={false} disabled aria-label="References" />
          <span className="wc-row__label">References: generated at typeset, never counted · {fmt(b.worksCited)} {b.worksCited === 1 ? 'work' : 'works'} cited</span>
        </div>
        {(v.parts.excluded > 0 || ignored > 0 || comments > 0) && (
          <div className="wc-row wc-row--muted" data-testid="wc-not-counted">
            <span className="wc-row__label">Not counted: {fmt(v.parts.excluded + ignored)} marked or ignored, {fmt(comments)} in comments</span>
          </div>
        )}
      </div>

      <div className="wc-group" role="group" aria-label="Kinds">
        <div className="wc-group__title">Kinds, in the counted parts</div>
        {KINDS.map((k: Kind) => (
          <label key={k} className="wc-row">
            <input type="checkbox" checked={rule.kinds.includes(k)} disabled={!editable} onChange={(e) => apply(withKind(rule, k, e.target.checked))} data-testid={`wc-kind-${k}`} />
            <span className="wc-row__label">{KIND_LABELS[k]}</span>
            <span className="wc-row__n">{fmt(v.kinds[k])}</span>
          </label>
        ))}
        <label className="wc-row">
          <input type="checkbox" checked={rule.formulas === 'one-word'} disabled={!editable} onChange={(e) => apply({ ...rule, formulas: e.target.checked ? 'one-word' : 'none' })} data-testid="wc-formulas" />
          <span className="wc-row__label">Count each formula as one word</span>
          <span className="wc-row__n">{fmt(v.formulas.inline)} inline, {fmt(v.formulas.display)} displayed</span>
        </label>
      </div>

      {v.sections.length > 0 && (
        <div className="wc-group" role="group" aria-label="By section">
          <div className="wc-group__title">By section</div>
          {v.sections.map((s, i) => {
            const over = sectionOverride(rule, s.title);
            return (
              <div key={`${s.file}:${s.line}:${i}`} className="wc-row wc-row--section" data-testid={`wc-section-${i}`}>
                <button type="button" className="wc-link wc-row__label" onClick={() => jump(s.file, s.line)} title={`${s.file}:${s.line}`}>
                  {s.title ?? 'Before the first heading'}
                </button>
                <span className="wc-row__n">{fmt(s.counted)}</span>
                <select
                  aria-label={`Count “${s.title ?? 'Before the first heading'}” as`}
                  value={over ?? ''}
                  disabled={!editable || s.title == null}
                  onChange={(e) => apply(withSection(rule, s.title!, (e.target.value || null) as Part | null))}
                  data-testid={`wc-section-${i}-part`}
                >
                  <option value="">{`Automatic (${PART_LABELS[s.part]})`}</option>
                  {COUNT_AS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {reasons.length > 0 && (
        <div className="wc-group" role="group" aria-label="Why parts were found">
          <div className="wc-group__title">Found automatically</div>
          {reasons.slice(0, 12).map((w, i) => (
            <button key={i} type="button" className="wc-link wc-why" onClick={() => jump(w.file, w.line)} data-testid={`wc-why-${i}`}>
              {PART_LABELS[w.part]}: {w.reason}, {w.file}:{w.line}
            </button>
          ))}
        </div>
      )}

      <div className="wc-group wc-group--facts">
        <div>{fmt(v.characters.counted)} characters, {fmt(v.characters.countedWithSpaces)} with spaces</div>
        <div>About {v.readingMinutes} min to read</div>
        {b.otherDocuments.length > 0 && <div>Other documents: {b.otherDocuments.map((d) => `${d.file} (${words(d.total)})`).join(', ')}</div>}
        {b.unresolved.length > 0 && <div>Not followed: {b.unresolved.slice(0, 5).map((u) => `${u.target} (${u.file}:${u.line})`).join(', ')}</div>}
      </div>

      <div className="wc-pop__foot">
        <button type="button" className="btn btn--ghost btn--small" onClick={copy} data-testid="wc-copy">{copied ? 'Copied' : 'Copy breakdown'}</button>
        {!editable && <span className="wc-pop__note" data-testid="wc-readonly">Set by the project’s editors</span>}
      </div>
    </div>
  );
}
