/**
 * Explanations of automatic edits (WP08 typing-core). A rule's notice
 * (AutoEdit.notice) appears at most NOTICE_LIMIT times per kind in this
 * browser, with a "Turn off" action that sets the rule's setting to false;
 * reverting the same rule REVERTS_BEFORE_OFFER times in one tab offers to
 * turn it off, once. Nothing appears while "Explain automatic changes"
 * (typing.explain) is off, or in an editor whose host provides no sink.
 */
import { Facet, type EditorState } from '@codemirror/state';
import { getSetting, setSetting } from '../../settings/store';
import { settingDef } from '../../settings/registry';
import { CORE_SETTING_IDS } from '../../settings/types';
import { safeStorage } from '../../util/safeStorage';
import type { AutoEditNotice } from './types';

export interface NoticeAction { label: string; run(): void }

/** The editor page's toast: EditorFeatureCtx.notify's shape. */
export type NoticeSink = (text: string, kind?: 'info' | 'ok' | 'error', action?: NoticeAction) => void;

/** Where notices go. The editor host provides it next to autoEditCore; without a provider notices are dropped. */
export const autoEditNotices: Facet<NoticeSink, NoticeSink | null> = Facet.define<NoticeSink, NoticeSink | null>({
  combine: (sinks) => sinks[sinks.length - 1] ?? null,
});

export const NOTICE_LIMIT = 3;
export const REVERTS_BEFORE_OFFER = 2;
/** Device key: how often each notice kind was shown, `{ [kind]: count }`. */
export const NOTICE_COUNTS_KEY = 'aldine.typing.noticesShown';

type Counts = Record<string, number>;

const isCounts = (v: unknown): v is Counts =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((n) => typeof n === 'number');

function explaining(): boolean {
  try {
    return getSetting<unknown>(CORE_SETTING_IDS.explainAutomatic) !== false;
  } catch {
    return true;
  }
}

function turnOff(settingId: string): NoticeAction {
  return {
    label: 'Turn off',
    run() {
      try {
        setSetting(settingId, false);
      } catch (err) {
        console.warn(`Could not turn off ${settingId}`, err);
      }
    },
  };
}

/** Shows `n` unless its kind was shown NOTICE_LIMIT times here already; true when shown. */
export function showAutoEditNotice(state: EditorState, n: AutoEditNotice): boolean {
  const sink = state.facet(autoEditNotices);
  if (!sink || !explaining()) return false;
  const counts = safeStorage.getJSON<Counts>(NOTICE_COUNTS_KEY, {}, isCounts);
  const shown = Object.prototype.hasOwnProperty.call(counts, n.kind) ? counts[n.kind] : 0;
  if (shown >= NOTICE_LIMIT) return false;
  safeStorage.setJSON(NOTICE_COUNTS_KEY, { ...counts, [n.kind]: shown + 1 });
  try {
    sink(n.text, 'info', turnOff(n.settingId));
  } catch (err) {
    console.warn('Could not show an automatic-edit notice', err);
  }
  return true;
}

/** This tab's reverts per rule, and the rules already offered. */
const reverts = new Map<string, number>();
const offered = new Set<string>();

/** Counts a Backspace revert of `rule`; on the second one offers to turn its setting off. True when the offer was shown. */
export function noteAutoEditRevert(state: EditorState, rule: string, settingId: string | undefined): boolean {
  if (!settingId) return false;
  const count = (reverts.get(rule) ?? 0) + 1;
  reverts.set(rule, count);
  if (count < REVERTS_BEFORE_OFFER || offered.has(rule)) return false;
  let label: string | undefined;
  try {
    label = settingDef(settingId)?.label;
  } catch {
    label = undefined;
  }
  const text = label
    ? `You reverted this change twice. Turn off “${label}”?`
    : 'You reverted this automatic change twice. Turn it off?';
  const shown = showAutoEditNotice(state, { kind: `revert:${rule}`, text, settingId });
  if (shown) offered.add(rule);
  return shown;
}

/** Forgets every count (tests; a "show explanations again" control). */
export function resetAutoEditNotices(): void {
  safeStorage.remove(NOTICE_COUNTS_KEY);
  reverts.clear();
  offered.clear();
}
