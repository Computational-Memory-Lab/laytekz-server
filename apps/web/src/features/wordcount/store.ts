/**
 * F13 word count, the live state (WP27): the server's breakdown for the open
 * branch, the open file's text and selection from the editor, and the numbers
 * the status shows, recomputed by splicing the open file into the breakdown
 * (model.ts). The server is asked again on open, when files change, after an
 * agent's write or a typeset, when the rule changes, when the tab comes back,
 * every 30 s while co-authors are here, and whenever the splice cannot stand
 * in for it.
 */
import { apiRequest } from '../../api';
import { getSetting, subscribeSetting } from '../../settings/store';
import { DEFAULT_RULE, resolveRule, type WordCountRule } from '../../wordcount/engine';
import type { EditorPageCtx } from '../types';
import { deriveView, fileWords, selectionWords, splice, type Breakdown, type CountView } from './model';

export const RULE_SETTING = 'wordcount.rule';
export const SHOW_SETTING = 'wordcount.show';

/** After a splice that cannot stand in for the server (the file includes others, or its exit state changed). */
const REFETCH_MS = 1000;
/** While co-authors are on the branch, their edits to other files show within this. */
const POLL_MS = 30_000;
/** Events that change files on the server arrive in bursts. */
const SETTLE_MS = 300;

export interface WordCountSnapshot {
  projectId: string;
  branch: string;
  file: string | null;
  breakdown: Breakdown | null;
  /** The rule the numbers are counted under: the server's, or one this tab has just set. */
  rule: WordCountRule;
  /** The document's numbers with the open file live; null until the server answered. */
  view: CountView | null;
  /** The open file is part of the document. */
  inDoc: boolean;
  /** The figure the status shows: the document total, or the open file's own count when it is outside the document. */
  total: number;
  sel: number | null;
  loading: boolean;
  failed: boolean;
}

interface LiveText { key: string; file: string; text: string; sel: string | null; rev: number }

let page: EditorPageCtx | null = null;
let breakdown: Breakdown | null = null;
let breakdownKey = '';
let live: LiveText | null = null;
let pendingRule: { rule: WordCountRule; seq: number } | null = null;
let loading = false;
let failed = false;
let seq = 0;
/** Bumped when the open file's text changes; the last fetch started at `fetchedRev`. */
let liveRev = 0;
let fetchedRev = -1;
let snapshot: WordCountSnapshot | null = null;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export const branchKey = (projectId: string, branch: string) => `${projectId}::${branch}`;

function changed(): void {
  snapshot = null;
  for (const fn of [...listeners]) fn();
}

export function subscribeWordCount(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function currentRule(): WordCountRule {
  return pendingRule?.rule ?? breakdown?.rule ?? DEFAULT_RULE;
}

function compute(): WordCountSnapshot {
  const p = page;
  const key = p ? branchKey(p.projectId, p.branch) : '';
  const file = p?.activeFile() ?? null;
  const b = breakdownKey === key ? breakdown : null;
  const rule = currentRule();
  const text = live && live.key === key && live.file === file ? live : null;
  let view: CountView | null = null;
  let inDoc = false;
  let total = 0;
  if (b && file) {
    inDoc = b.occurrences.some((o) => o.file === file);
    let segments = b.segments;
    if (inDoc && text) {
      const r = splice(b, file, text.text, rule);
      if (r.segments) segments = r.segments;
      // only for text the server has not been asked about yet, or a file with includes would refetch forever
      if (r.refetch && text.rev > fetchedRev) scheduleRefetch(REFETCH_MS);
    }
    view = deriveView(segments, rule);
    total = inDoc ? view.total : text ? fileWords(text.text, rule, b.macros) : 0;
  } else if (text) {
    total = fileWords(text.text, rule);
  }
  const sel = text?.sel != null ? selectionWords(text.sel, b?.macros ?? []) : null;
  return { projectId: p?.projectId ?? '', branch: p?.branch ?? '', file, breakdown: b, rule, view, inDoc, total, sel, loading, failed };
}

/** The numbers for the page that is open; stable between changes (useSyncExternalStore). */
export function wordCountSnapshot(): WordCountSnapshot {
  if (!snapshot) snapshot = compute();
  return snapshot;
}

/** Asks the server for the breakdown of the open branch now. */
export async function refreshWordCount(): Promise<void> {
  const p = page;
  if (!p) return;
  if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null; }
  const mine = ++seq;
  const key = branchKey(p.projectId, p.branch);
  fetchedRev = liveRev;
  loading = true;
  changed();
  try {
    const b = await apiRequest<Breakdown>(`/api/projects/${encodeURIComponent(p.projectId)}/wordcount/breakdown?branch=${encodeURIComponent(p.branch)}`);
    if (page !== p || mine !== seq) return;
    breakdown = b;
    breakdownKey = key;
    failed = false;
    if (pendingRule && pendingRule.seq < mine) pendingRule = null;
  } catch {
    if (page !== p || mine !== seq) return;
    // No main document, or the server is away: the open file's own count stands in.
    if (breakdownKey !== key) breakdown = null;
    failed = true;
  } finally {
    if (page === p && mine === seq) { loading = false; changed(); }
  }
}

function scheduleRefetch(ms: number): void {
  if (!page || refetchTimer) return;
  refetchTimer = setTimeout(() => { refetchTimer = null; void refreshWordCount(); }, ms);
}

/** Shows `rule` at once while it is being saved; the next answer from the server replaces it. */
export function previewRule(stored: unknown): void {
  pendingRule = { rule: resolveRule(stored), seq };
  changed();
}

/** The editor's report: the open file's text and the selected text (null when nothing is selected). */
export function reportLive(projectId: string, branch: string, file: string, text: string, sel: string | null): void {
  const key = branchKey(projectId, branch);
  if (live && live.key === key && live.file === file && live.text === text && live.sel === sel) return;
  const sameFile = !!live && live.key === key && live.file === file;
  // A file's first text is what the collab doc synced from the server: not news to it.
  const rev = !sameFile ? liveRev : live!.text === text ? live!.rev : ++liveRev;
  live = { key, file, text, sel, rev };
  changed();
}

/** Per editor page (FeatureModule.activate): fetch now, then keep the breakdown fresh until the page closes. */
export function watchWordCount(p: EditorPageCtx): () => void {
  page = p;
  breakdown = null;
  breakdownKey = '';
  pendingRule = null;
  failed = false;
  changed();
  if (getSetting<boolean>(SHOW_SETTING) !== false) void refreshWordCount();
  let settle: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (getSetting<boolean>(SHOW_SETTING) === false) return;
    if (settle) clearTimeout(settle);
    settle = setTimeout(() => { settle = null; void refreshWordCount(); }, SETTLE_MS);
  };
  const offs = [
    p.events.on('filesChanged', soon),
    p.events.on('agentWrite', soon),
    p.events.on('compileFinished', soon),
    p.events.on('filesMoved', soon),
    p.events.on('activeFile', () => changed()),
    p.events.on('projectSettingsChanged', ({ ids }) => { if (ids.includes(RULE_SETTING)) soon(); }),
    p.events.on('visibility', ({ visible }) => { if (visible) soon(); }),
    subscribeSetting(SHOW_SETTING, () => { if (getSetting<boolean>(SHOW_SETTING) !== false) soon(); changed(); }),
  ];
  const poll = setInterval(() => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    let peers = 0;
    try { peers = p.peers().length; } catch { peers = 0; }
    if (peers > 0) soon();
  }, POLL_MS);
  return () => {
    for (const off of offs) off();
    clearInterval(poll);
    if (settle) clearTimeout(settle);
    if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null; }
    if (page === p) { page = null; breakdown = null; breakdownKey = ''; live = null; pendingRule = null; seq += 1; loading = false; changed(); }
  };
}

/** The page whose word count is shown (the commands use it). */
export const wordCountPage = () => page;

/** Test seam: forget everything. */
export function __resetWordCount(): void {
  page = null; breakdown = null; breakdownKey = ''; live = null; pendingRule = null; loading = false; failed = false; seq = 0; snapshot = null;
  liveRev = 0; fetchedRev = -1;
  if (refetchTimer) { clearTimeout(refetchTimer); refetchTimer = null; }
}
