/**
 * The rename preview (WP29, F10): what renaming a file would change, with a
 * box for every sibling and reference. Mounted on its own root while open
 * (the interceptor runs outside React), gone once it closes.
 */
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Modal from '../../components/Modal';
import {
  blockingMessage, danglingNote, dialogTitle, editEnabled, editNote, editsByFile, initialSelection, onlyLabel, primaryLabel,
  requested, siblingNote, siblings, toggleEdit, toggleRename, chosenEdits,
  type PlanEdit, type RenamePlan, type Selection,
} from './plan';
import type { PreviewChoice } from './flow';
import './rename.css';

function Diff({ e }: { e: PlanEdit }) {
  return (
    <span className="rename-preview__diff">
      <code className="rename-preview__del" data-testid="rename-edit-before"><span aria-hidden>− </span>{e.before.trim()}</code>
      <code className="rename-preview__add" data-testid="rename-edit-after"><span aria-hidden>+ </span>{e.after.trim()}</code>
    </span>
  );
}

function RenamePreview({ plan, manual, done }: { plan: RenamePlan; manual: boolean; done(c: PreviewChoice): void }) {
  const [sel, setSel] = useState<Selection>(() => initialSelection(plan));
  const [always, setAlways] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const req = requested(plan);
  const sibs = siblings(plan);
  const groups = editsByFile(plan);
  const blocked = blockingMessage(plan);
  const dir = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
  // The main document moving to another folder: the paths it resolves from that folder change with it.
  const rootMoves = plan.settings.some((s) => s.label === 'Main document') && dir(req.from) !== dir(req.to);
  const relative = rootMoves ? plan.edits.filter((e) => (e.follows ?? req.from) === req.from).length : 0;

  return (
    <Modal onClose={() => done({ kind: 'cancel' })} label={dialogTitle(plan)} testId="rename-preview" width={620} className="rename-preview" initialFocus={blocked ? 'first' : primary}>
      <form onSubmit={(ev) => { ev.preventDefault(); if (!blocked) done({ kind: 'apply', selection: sel, always }); }}>
        <h2 data-testid="rename-preview-title">{dialogTitle(plan)}</h2>

        {plan.warnings.length > 0 && (
          <ul className="rename-preview__warnings" data-testid="rename-preview-warnings">
            {plan.warnings.map((w, i) => (
              <li key={i} className={w.blocking ? 'is-blocking' : undefined} data-testid={`rename-warning-${w.kind}`}>{w.message}</li>
            ))}
          </ul>
        )}

        <section className="rename-preview__section" aria-label="Files">
          <h3>Files</h3>
          <ul className="rename-preview__list">
            <li>
              <label className="rename-preview__row">
                <input type="checkbox" checked disabled data-testid="rename-file-requested" />
                <span className="rename-preview__what"><code>{req.from}</code> → <code>{req.to}</code></span>
              </label>
            </li>
            {sibs.map((s) => (
              <li key={s.from}>
                <label className={`rename-preview__row${s.disabled ? ' is-disabled' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!s.disabled && sel.renames.has(s.from)}
                    disabled={s.disabled}
                    onChange={(ev) => setSel(toggleRename(plan, sel, s.from, ev.target.checked))}
                    data-testid={`rename-file-${s.from}`}
                  />
                  <span className="rename-preview__what"><code>{s.from}</code> → <code>{s.to}</code></span>
                  <span className="rename-preview__note">{siblingNote(s)}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        {groups.length > 0 && (
          <section className="rename-preview__section" aria-label="References">
            <h3>References</h3>
            {relative > 0 && <p className="rename-preview__sub">Paths written relative to the main document change ({relative})</p>}
            {groups.map((g) => (
              <div key={g.file} className="rename-preview__group">
                <div className="rename-preview__file">{g.file}</div>
                <ul className="rename-preview__list">
                  {g.edits.map((e) => {
                    const enabled = editEnabled(plan, sel, e);
                    const note = editNote(e);
                    const dangling = danglingNote(plan, sel, e);
                    return (
                      <li key={e.id}>
                        <label className={`rename-preview__row rename-preview__row--edit${enabled ? '' : ' is-disabled'}`}>
                          <input
                            type="checkbox"
                            checked={enabled && sel.edits.has(e.id)}
                            disabled={!enabled}
                            onChange={(ev) => setSel(toggleEdit(plan, sel, e.id, ev.target.checked))}
                            data-testid={`rename-edit-${e.file}:${e.line}`}
                            data-kind={e.kind}
                          />
                          <span className="rename-preview__where">{e.file}:{e.line}</span>
                          <Diff e={e} />
                          {note && <span className="rename-preview__note">{note}</span>}
                          {dangling && <span className="rename-preview__warn" data-testid="rename-edit-dangling">{dangling}</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </section>
        )}

        {plan.settings.length > 0 && (
          <section className="rename-preview__section" aria-label="Settings">
            <h3>Settings</h3>
            <ul className="rename-preview__list rename-preview__list--plain">
              {plan.settings.map((s) => (
                <li key={s.label} data-testid="rename-setting">{s.label}: <code>{s.from}</code> → <code>{s.to}</code></li>
              ))}
            </ul>
          </section>
        )}

        {plan.unresolved.length > 0 && (
          <section className="rename-preview__section" aria-label="Needs your attention">
            <h3>Needs your attention</h3>
            <p className="rename-preview__sub">Laytekz cannot change these, because the path is built from a macro or written without braces.</p>
            <ul className="rename-preview__list rename-preview__list--plain">
              {plan.unresolved.map((u, i) => (
                <li key={i} data-testid="rename-unresolved"><span className="rename-preview__where">{u.file}:{u.line}</span> <code>{u.text.trim()}</code></li>
              ))}
            </ul>
          </section>
        )}

        <label className="rename-preview__always">
          <input type="checkbox" checked={always} onChange={(ev) => setAlways(ev.target.checked)} data-testid="rename-always" />
          Always update references without asking
        </label>
        <p className="rename-preview__sub rename-preview__foot">
          {manual ? 'Undo in the notification puts everything back.' : 'One commit. Undo in the notification or in History puts everything back.'}
        </p>

        <div className="modal__row rename-preview__actions">
          <button type="button" className="btn" onClick={() => done({ kind: 'cancel' })} data-testid="rename-cancel">Cancel</button>
          <button type="button" className="btn" onClick={() => done({ kind: 'only' })} disabled={!!blocked} data-testid="rename-only">{onlyLabel(plan)}</button>
          <button ref={primary} type="submit" className="btn btn--primary" disabled={!!blocked} data-testid="rename-confirm">
            {primaryLabel(plan, sel)}
          </button>
        </div>
        <span hidden data-testid="rename-chosen-count">{chosenEdits(plan, sel).length}</span>
      </form>
    </Modal>
  );
}

/** Opens the preview and resolves the choice; Escape, a click outside and Cancel all cancel. */
export function openRenamePreview(plan: RenamePlan, o: { manual: boolean }): Promise<PreviewChoice> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let closed = false;
    const done = (c: PreviewChoice) => {
      if (closed) return;
      closed = true;
      resolve(c);
      // after the event that closed it: a root is not unmounted from its own handler
      setTimeout(() => { root.unmount(); host.remove(); });
    };
    root.render(<RenamePreview plan={plan} manual={o.manual} done={done} />);
  });
}
