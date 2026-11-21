import type { EditorPageCtx, FeatureModule } from '../types';
import { KEY_CHAIN_PRIORITY } from '../../editor/core/types';
import { setMacroContext } from '../../editor/visual/context';
import { caretPreviewField, closePreview, mathPreviewExtension, pinPreview } from './extension';
import { MATH_PREVIEW_SETTING_IDS as ids, type PreviewBackground, type PreviewDelay, type PreviewSizeChoice } from './settings';

declare global {
  // Vite's import.meta.glob (vitest has it too); the web app's tsconfig loads no vite/client types.
  interface ImportMeta { glob(pattern: string): Record<string, () => Promise<unknown>> }
}

/**
 * The PDF layer (WP21) lives in ./pdf and is loaded when it exists: its
 * `pdf/index.ts` exports `activate(page)`, which registers a preview tier
 * (api.ts registerPreviewTier) and returns its cleanup. Until then the glob
 * matches nothing and KaTeX is the only tier.
 */
const PDF_LAYER = import.meta.glob('./pdf/index.ts');
interface PdfLayer { activate?(page: EditorPageCtx): void | (() => void) }

const PIN = 'mathPreview.pin';

/** F3: hover over math in the source and see it drawn (WP13); the exact PDF crop is WP21's tier. */
const feature: FeatureModule = {
  id: 'mathPreview',
  editor: {
    deps: [ids.hover, ids.caret, ids.delay, ids.size, ids.background],
    extension(ctx) {
      // off: nothing is installed and KaTeX is never preloaded
      if (ctx.setting<boolean>(ids.hover) === false) return [];
      setMacroContext(ctx.projectId, ctx.branch, ctx.rootFile);
      return mathPreviewExtension({
        delay: ctx.setting<PreviewDelay>(ids.delay) ?? 350,
        caret: ctx.setting<boolean>(ids.caret) === true,
        paper: (ctx.setting<PreviewBackground>(ids.background) ?? 'paper') !== 'theme',
        size: ctx.setting<PreviewSizeChoice>(ids.size) ?? 'medium',
        filePath: ctx.filePath,
      });
    },
    keyChains: [{ key: 'Escape', priority: KEY_CHAIN_PRIORITY.Escape.pinnedPreview, id: 'mathPreview.close', run: closePreview }],
  },
  commands: (page) => [{
    id: PIN,
    title: 'Preview the formula at the cursor',
    group: 'Editor',
    keywords: 'math equation formula preview pin katex show',
    keybinding: PIN,
    run: () => {
      const view = page.view();
      if (!view) return;
      if (!view.state.field(caretPreviewField, false)) {
        page.toast('Formula previews are off.', 'info', { label: 'Turn on', run: () => page.openSettings({ section: 'math', setting: ids.hover }) });
        return;
      }
      if (!pinPreview(view)) page.toast('Put the cursor in a formula to preview it.', 'info');
    },
  }],
  // Unbound by default (plan §1.1): the person picks a chord under Shortcuts.
  keybindings: [{ id: PIN, label: 'Preview the formula at the cursor', group: 'Editor', default: null, changeable: true, scope: 'editor', command: PIN }],
  activate(page) {
    const offs: (() => void)[] = [];
    let live = true;
    for (const load of Object.values(PDF_LAYER)) {
      void load().then((m) => {
        if (!live) return;
        const off = (m as PdfLayer).activate?.(page);
        if (typeof off === 'function') offs.push(off);
      }).catch((err) => console.warn('The formula preview could not load its PDF layer', err));
    }
    return () => {
      live = false;
      for (const off of offs) off();
    };
  },
};

export default feature;
