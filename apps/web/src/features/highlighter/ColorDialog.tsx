/**
 * "Custom colour…" (WP37): a native colour picker and a hex field, a preview
 * on both themes at the current strength, readability warnings that never
 * block, "Pick from screen" where the browser has an eyedropper, and "Your
 * colours" with remove buttons.
 */
import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Modal from '../../components/Modal';
import { useSetting } from '../../settings/store';
import { normalizeHex } from './model';
import { MIX, THEME_INK, addCustom, cleanCustomList, mixOver, readabilityWarnings, removeCustom } from './colors';
import type { ColorDialogOptions } from './dialog';
import './ui.css';

type Strength = 'light' | 'medium' | 'strong';

interface EyeDropperLike { open(): Promise<{ sRGBHex: string }> }

function ColorDialog({ o, close }: { o: ColorDialogOptions; close(): void }) {
  const start = o.initial && normalizeHex(o.initial).ok ? (normalizeHex(o.initial) as { color: string }).color : '#ffd60a';
  const [text, setText] = useState(start);
  const [custom, setCustom] = useSetting<string[]>('highlighter.customColors');
  const [strengthRaw] = useSetting<string>('highlighter.strength');
  const strength: Strength = strengthRaw === 'light' || strengthRaw === 'strong' ? strengthRaw : 'medium';
  const input = useRef<HTMLInputElement>(null);
  const parsed = normalizeHex(text);
  const color = parsed.ok ? parsed.color : null;
  const warnings = useMemo(() => (color ? readabilityWarnings(color, strength) : []), [color, strength]);
  const [dropperFailed, setDropperFailed] = useState(false);
  const hasDropper = typeof window !== 'undefined' && 'EyeDropper' in window && !dropperFailed;
  const list = cleanCustomList(custom);

  const apply = () => {
    if (!color) return;
    setCustom(addCustom(custom, color));
    close();
    o.onPick(color);
  };

  const pickFromScreen = async () => {
    try {
      const Ctor = (window as unknown as { EyeDropper: new () => EyeDropperLike }).EyeDropper;
      const r = await new Ctor().open();
      const n = normalizeHex(r.sRGBHex);
      if (n.ok) setText(n.color);
    } catch (err) {
      // A cancelled pick rejects with AbortError; anything else hides the button.
      if (!(err instanceof DOMException && err.name === 'AbortError')) setDropperFailed(true);
    }
  };

  return (
    <Modal onClose={close} label="Custom highlight colour" testId="highlight-color-dialog" initialFocus={input}>
      <form onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <h2>Custom highlight colour</h2>
        <div className="hl-dialog__row">
          <input
            type="color"
            className="hl-dialog__picker"
            aria-label="Colour picker"
            value={color ?? '#ffd60a'}
            onChange={(e) => setText(e.target.value)}
            data-testid="highlight-color-picker"
          />
          <input
            ref={input}
            className="input hl-dialog__hex"
            aria-label="Hex colour"
            aria-invalid={!parsed.ok}
            aria-describedby="hl-dialog-error"
            value={text}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setText(e.target.value)}
            data-testid="highlight-color-hex"
          />
          {hasDropper && (
            <button type="button" className="btn btn--small" onClick={() => { void pickFromScreen(); }} data-testid="highlight-color-eyedropper">Pick from screen</button>
          )}
        </div>
        {!parsed.ok && text.trim() !== '' && (
          <p className="hl-dialog__error" id="hl-dialog-error" role="alert" data-testid="highlight-color-error">{parsed.error}</p>
        )}
        {color && (
          <div className="hl-dialog__previews" aria-hidden="true">
            {(['light', 'dark'] as const).map((theme) => (
              <div
                key={theme}
                className="hl-dialog__preview"
                style={{ background: THEME_INK[theme].bg, color: THEME_INK[theme].text }}
                data-testid={`highlight-color-preview-${theme}`}
              >
                <span style={{ background: mixOver(color, THEME_INK[theme].bg, MIX[theme][strength]) }}>
                  {'\\textbf{Result} '}<span style={{ color: THEME_INK[theme].comment }}>% note</span>
                </span>
              </div>
            ))}
          </div>
        )}
        {warnings.length > 0 && (
          <ul className="hl-dialog__warnings" data-testid="highlight-color-warnings">
            {warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}
        {list.length > 0 && (
          <div className="hl-dialog__yours">
            <div className="hl-dialog__label">Your colours</div>
            <div className="hl-dialog__chips">
              {list.map((c) => (
                <span key={c} className="hl-dialog__chip" data-testid={`highlight-your-color-${c.slice(1)}`}>
                  <button type="button" className="hl-swatch-btn" title={c} aria-label={`Use ${c}`} onClick={() => setText(c)}>
                    <span className="hl-swatch hl-swatch--custom" style={{ ['--hl' as string]: c }} />
                  </button>
                  <button
                    type="button"
                    className="hl-dialog__remove"
                    aria-label={`Remove ${c} from your colours`}
                    title="Remove"
                    onClick={() => setCustom(removeCustom(custom, c))}
                    data-testid={`highlight-your-color-remove-${c.slice(1)}`}
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="modal__row">
          <button type="button" className="btn" onClick={close} data-testid="highlight-color-cancel">Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!color} data-testid="highlight-color-apply">Highlight</button>
        </div>
      </form>
    </Modal>
  );
}

/** Renders the dialog in a root of its own; `done` runs when it closes. */
export function mountColorDialog(o: ColorDialogOptions, done: () => void): void {
  const host = document.createElement('div');
  host.setAttribute('data-highlight-dialog-host', '');
  document.body.appendChild(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    setTimeout(() => { root.unmount(); host.remove(); done(); }, 0);
  };
  root.render(<ColorDialog o={o} close={close} />);
}
