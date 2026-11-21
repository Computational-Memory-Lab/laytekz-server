import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useBackdropDismiss } from '../../components/Modal';
import './picker.css';

export interface PickerRow {
  id: string;
  /** The row's main line and anything after it. */
  content: ReactNode;
  /** Right side: key, badges. */
  aside?: ReactNode;
  testId?: string;
  /** Marked as already chosen (a chip). */
  chosen?: boolean;
}

export interface PickerChip { id: string; label: string; title?: string; error?: boolean }

export interface PickerShellProps {
  /** The dialog's name, shown as its heading. */
  label: string;
  /** Beside the heading: what was detected ("biblatex · APA"). */
  note?: ReactNode;
  query: string;
  onQuery(q: string): void;
  placeholder?: string;
  rows: readonly PickerRow[];
  active: number;
  onActive(i: number): void;
  chips?: readonly PickerChip[];
  onRemoveChip?(id: string): void;
  /** Enter (Shift held or not) in the search field; `i` is -1 without rows. */
  onChoose(i: number, o: { shift: boolean }): void;
  /** Tab in the search field while it has text; true when it was used. */
  onTab?(i: number): boolean;
  /** Sees every key in the dialog first; true when it was used. */
  onKey?(e: KeyboardEvent<HTMLDivElement>): boolean;
  onClose(): void;
  /** Shown instead of the list when there are no rows. */
  empty?: ReactNode;
  /** Between the list and the footer: options, notes, a preview. */
  children?: ReactNode;
  footer?: ReactNode;
  /** Test id of the dialog; rows default to `<testId>-row-<id>`. */
  testId: string;
}

/**
 * The keyboard picker the citation (WP19) and cross-reference (WP26) pickers
 * share: a search field in the ARIA combobox pattern (focus stays in the
 * field, the highlighted row is its active descendant), chips for what was
 * chosen, and room for options below. ↑/↓ move, Enter and Shift+Enter
 * choose, Tab adds the highlighted row while the field has text, Backspace
 * in an empty field removes the last chip, Esc closes. A full-width sheet on phones.
 */
export default function PickerShell(p: PickerShellProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backdrop = useBackdropDismiss(p.onClose);
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [p.active]);

  const onDialogKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (p.onKey?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); }
  };

  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const n = p.rows.length;
    if (e.key === 'ArrowDown') { e.preventDefault(); if (n) p.onActive(Math.min(p.active + 1, n - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) p.onActive(Math.max(p.active - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); p.onChoose(n ? p.active : -1, { shift: e.shiftKey }); }
    else if (e.key === 'Tab' && !e.shiftKey && p.query.trim() && n && p.onTab?.(p.active)) e.preventDefault();
    else if (e.key === 'Backspace' && !p.query && p.chips?.length && p.onRemoveChip) { e.preventDefault(); p.onRemoveChip(p.chips[p.chips.length - 1].id); }
  };

  return (
    <div className="modal-backdrop picker-backdrop" {...backdrop} data-testid={`${p.testId}-backdrop`}>
      <div className="picker" role="dialog" aria-modal="true" aria-label={p.label} data-testid={p.testId} onKeyDown={onDialogKey} onClick={(e) => e.stopPropagation()}>
        <div className="picker__head">
          <span className="picker__title">{p.label}</span>
          {p.note && <span className="picker__note" data-testid={`${p.testId}-note`}>{p.note}</span>}
        </div>
        <div className="picker__field">
          {p.chips?.map((c) => (
            <span key={c.id} className={`picker__chip${c.error ? ' picker__chip--error' : ''}`} title={c.title} data-testid={`${p.testId}-chip-${c.id}`}>
              {c.label}
              {p.onRemoveChip && (
                <button type="button" className="picker__chip-x" aria-label={`Remove ${c.label}`} tabIndex={-1} onClick={() => { p.onRemoveChip!(c.id); inputRef.current?.focus(); }}>×</button>
              )}
            </span>
          ))}
          <input
            ref={inputRef}
            className="picker__input"
            placeholder={p.placeholder}
            value={p.query}
            role="combobox"
            aria-expanded={p.rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={p.rows[p.active] ? optionId(p.active) : undefined}
            aria-label={p.label}
            autoComplete="off"
            spellCheck={false}
            data-testid={`${p.testId}-input`}
            onChange={(e) => p.onQuery(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </div>
        {p.rows.length === 0 && p.empty && <div className="picker__empty" role="status" data-testid={`${p.testId}-empty`}>{p.empty}</div>}
        <div className="picker__list" ref={listRef} role="listbox" id={listId} aria-label="Results" hidden={p.rows.length === 0}>
          {p.rows.map((r, i) => (
            <div
              key={r.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === p.active}
              data-active={i === p.active}
              className={`picker__row${i === p.active ? ' picker__row--active' : ''}${r.chosen ? ' picker__row--chosen' : ''}`}
              data-testid={r.testId ?? `${p.testId}-row-${r.id}`}
              onPointerMove={() => { if (i !== p.active) p.onActive(i); }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => p.onChoose(i, { shift: e.shiftKey })}
            >
              <div className="picker__row-main">{r.content}</div>
              {r.aside && <div className="picker__row-aside">{r.aside}</div>}
            </div>
          ))}
        </div>
        {p.children}
        {p.footer && <div className="picker__footer">{p.footer}</div>}
      </div>
    </div>
  );
}
