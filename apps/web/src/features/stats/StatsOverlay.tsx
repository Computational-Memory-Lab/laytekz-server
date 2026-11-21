import { useEffect, useMemo, useSyncExternalStore } from 'react';
import CommandPalette, { type Command } from '../../components/CommandPalette';
import type { SlotProps } from '../../slots/types';
import { CATALOGUE, GROUPS } from './core/catalogue';
import { sample } from './core/render';
import { insertAtSelection } from './insert';
import { convertPasted, dismissPaste } from './paste';
import { clearOffer, closePicker, getUi, subscribeUi } from './ui';
import './stats.css';

/**
 * The statistics picker (Insert statistic, ⇧⌘U) and the paste offer, drawn
 * at the end of the editor shell (slot editor.overlay).
 */

const OFFER_MS = 15000;

function plain(entry: (typeof CATALOGUE)[number]): string {
  return sample(entry).replace(/\$/g, '').replace(/\\mathit\{([^}]*)\}|\\mathrm\{([^}]*)\}/g, '$1$2').replace(/\\%/g, '%').replace(/~/g, ' ');
}

export default function StatsOverlay({ page }: SlotProps) {
  const ui = useSyncExternalStore(subscribeUi, getUi, getUi);

  const commands = useMemo<Command[]>(() => CATALOGUE.map((e) => ({
    id: `stats-${e.id}`,
    title: e.title,
    hint: e.trigger ? `${e.trigger}  ${plain(e)}` : plain(e),
    group: e.group,
    keywords: `${e.keywords} ${e.trigger ?? ''} ${e.trigger?.slice(1) ?? ''}`,
    run: () => {
      // The palette hands focus back to the editor as it closes; insert after that.
      setTimeout(() => {
        const view = page?.view();
        if (!view) { page?.toast('Open a .tex file in the code editor to insert a statistic.', 'info'); return; }
        view.focus();
        const r = insertAtSelection(view, e);
        if ('converted' in r) page?.toast(`Converted ${r.converted} statistic${r.converted === 1 ? '' : 's'}. Undo brings back the text.`, 'ok');
      }, 0);
    },
  })), [page]);

  const offer = ui.offer;
  useEffect(() => {
    if (!offer) return;
    const t = setTimeout(() => { dismissPaste(offer); clearOffer(offer); }, OFFER_MS);
    return () => clearTimeout(t);
  }, [offer]);

  const convert = () => {
    if (!offer) return;
    const n = convertPasted(offer);
    clearOffer(offer);
    offer.focus();
    page?.toast(n ? `Converted ${n} statistic${n === 1 ? '' : 's'} to the house style. Undo brings back the paste.` : 'Nothing in the paste could be converted.', n ? 'ok' : 'info');
  };

  return (
    <>
      {ui.picker && (
        <div data-testid="stats-picker">
          <CommandPalette
            open={ui.picker}
            commands={commands}
            onClose={closePicker}
            placeholder="Find a statistic: p value, anova, bayes factor…"
            groupOrder={[...GROUPS]}
            idleSectionLimit={6}
          />
        </div>
      )}
      {offer && (
        <div className="stats-offer" role="status" data-testid="paste-stats-offer">
          <span className="stats-offer__text">This looks like test output. Convert it to APA style?</span>
          <button type="button" className="btn btn--small btn--primary" onClick={convert} data-testid="paste-stats-convert">Convert</button>
          <button type="button" className="btn btn--small btn--ghost" aria-label="Dismiss" onClick={() => { dismissPaste(offer); clearOffer(offer); }} data-testid="paste-stats-dismiss">Not now</button>
        </div>
      )}
    </>
  );
}
