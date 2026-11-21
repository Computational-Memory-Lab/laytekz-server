/** Auto-typeset timing and the branch-wide election that keeps N open tabs
 *  from rebuilding one PDF. Pure on purpose: the Editor owns the timers, the
 *  fetches and the awareness. */

export const LOCAL_AUTO_TYPESET_MS = 2000;
/** Longer than the local delay so an agent that typesets right after its edit
 *  (one model round trip) wins the race and no second run happens; short
 *  enough that an edit-only session still updates the preview. */
export const AGENT_AUTO_TYPESET_MS = 6000;
/** An agent typeset that never reports back (node gone, compile killed) must
 *  not leave the preview frozen; longer than the compiler's 120 s cap. */
export const AGENT_RUN_WATCHDOG_MS = 150_000;
/** Quiet time after a draft that left references or the bibliography behind
 *  before the full typeset runs; any keystroke restarts the wait. */
export const FULL_AFTER_DRAFT_MS = 4000;
/** A keystroke this recent may still be on its way to the server when a
 *  typeset starts, so the run might not contain it. */
const EDIT_IN_FLIGHT_MS = 500;

/** A typeset starting now covers the edits behind an armed local timer (and
 *  may cancel it) unless the last one could still be in flight. */
export function cancelsArmedTypeset(lastLocalEditAt: number, now: number): boolean {
  return now - lastLocalEditAt >= EDIT_IN_FLIGHT_MS;
}

export type TypesetSource = 'local' | 'agent';

export interface TypesetPeer {
  clientId: number;
  eligible: boolean;
  visible: boolean;
}

/** ms to wait before typesetting, or null to not arm at all. */
export function autoTypesetDelay(i: { source: TypesetSource; auto: boolean; hasTex: boolean }): number | null {
  if (!i.auto || !i.hasTex) return null;
  return i.source === 'agent' ? AGENT_AUTO_TYPESET_MS : LOCAL_AUTO_TYPESET_MS;
}

/** The one client that typesets an agent edit for the branch: the lowest
 *  collaboration id among the eligible ones, preferring a visible tab (a
 *  background tab's timers are throttled to as little as once a minute).
 *  Deterministic — every client computes the same winner from the same
 *  awareness, so no round trip is needed to agree. */
export function electTypesetter(peers: TypesetPeer[]): number | null {
  const eligible = peers.filter((p) => p.eligible);
  if (!eligible.length) return null;
  const visible = eligible.filter((p) => p.visible);
  const pool = visible.length ? visible : eligible;
  return pool.reduce((min, p) => (p.clientId < min ? p.clientId : min), pool[0].clientId);
}

/** Adopt a run the branch reports instead of compiling again: only a newer
 *  run, and never while this client's own typeset is still in flight. */
export function shouldAdoptRun(shownRunId: number | undefined, runId: number | undefined, busy: boolean): boolean {
  if (busy || runId === undefined) return false;
  return shownRunId === undefined || runId > shownRunId;
}

// Galley: V2 integrator: one typeset when the connection comes back after a loss (V1 left the preview on "Failed").

/** The parts of the open document's sync state (editor/syncStatus) a reconnection is read from. */
export interface LinkState { loaded: boolean; connected: boolean; online: boolean; unsynced?: boolean }

/** The document has synced, its socket is up and the browser says it is online. */
export function linkUp(s: LinkState): boolean {
  return s.loaded && s.connected && s.online;
}

/** A typeset starting now sees every edit made in this tab: the link is up and
 *  the server has confirmed them all. No open document has nothing to miss. */
export function runSeesLocalEdits(s: LinkState | null): boolean {
  return !s || (linkUp(s) && !s.unsynced);
}

/** A typeset request that never reached a working server (no answer, or a
 *  gateway saying the server is unreachable), not a document that fails. */
export function isNetworkFailure(status: number | undefined): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/**
 * Follows the open document's link, one sync report at a time (`key` names the
 * pane), and answers true exactly once each time the link comes back after a
 * loss, as soon as the edits made meanwhile have reached the server. A file's
 * first connection is not a return unless the browser said it was offline
 * first; a loss that began on one file ends on the next.
 */
export function reconnectWatch(): (key: string, s: LinkState) => boolean {
  let key: string | null = null;
  let wasUp = false;
  let lost = false;
  return (k, s) => {
    if (k !== key) { key = k; wasUp = false; }
    if (!linkUp(s)) {
      if (wasUp || !s.online) lost = true;
      return false;
    }
    wasUp = true;
    if (!lost || s.unsynced) return false;
    lost = false;
    return true;
  };
}

/**
 * On a reconnection, whether to typeset once: auto-typeset is on, no armed
 * timer will typeset anyway, and the preview is behind. A run still going is
 * behind when it started without the link; otherwise the last typeset failed
 * for want of the server, or this tab edited after the newest run that saw all
 * its edits started.
 */
export function retypesetOnReconnect(i: {
  auto: boolean;
  hasTex: boolean;
  armed: boolean;
  running: boolean;
  runSees: boolean;
  networkFailed: boolean;
  lastLocalEditAt: number;
  coveredAt: number;
}): boolean {
  if (!i.auto || !i.hasTex || i.armed) return false;
  if (i.running) return !i.runSees;
  return i.networkFailed || i.lastLocalEditAt > i.coveredAt;
}
