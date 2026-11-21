import type { Extension } from '@codemirror/state';
import type { FeatureModule } from '../types';
import { chipExtension } from './chip';
import ContextChip from './ContextChip';
import { PASTE_RAW_BINDING, pasteExtension } from './paste';
import { ESCAPE_RULES, ESCAPE_SETTING } from './rules';

/**
 * F1 (WP10): context-aware escaping of &, % and # as they are typed, escaped
 * plain-text paste in Source mode (⌘⇧V pastes exactly as copied), and the
 * typing-context chip. Each part has its own switch in Settings › Typing;
 * every automatic edit is one undo step that Backspace right after reverts.
 */
const feature: FeatureModule = {
  id: 'escape',
  editor: {
    deps: [ESCAPE_SETTING.paste, ESCAPE_SETTING.chip],
    autoEditRules: ESCAPE_RULES,
    extension(ctx): Extension {
      const on = (id: string) => ctx.setting<boolean>(id) !== false;
      return [
        // Visual mode keeps its own paste (it escapes prose already); the raw chord works in both.
        pasteExtension(ctx.mode() === 'source' && on(ESCAPE_SETTING.paste)),
        on(ESCAPE_SETTING.chip) ? chipExtension() : [],
      ];
    },
  },
  // The browsers' own "paste as plain text" chord, so it is not changeable:
  // the paste event comes from the browser, and no other chord would make one.
  keybindings: [{
    id: PASTE_RAW_BINDING,
    label: 'Paste exactly as copied',
    group: 'Editor',
    default: { mod: true, shift: true, alt: false, key: 'v' },
    changeable: false,
    scope: 'editor',
    command: PASTE_RAW_BINDING,
  }],
  slots: [{ id: 'escape.chip', slot: 'editor.status', order: 100, render: ContextChip }],
};

export default feature;
