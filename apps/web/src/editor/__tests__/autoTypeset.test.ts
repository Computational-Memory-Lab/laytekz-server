import { describe, it, expect } from 'vitest';
import {
  autoTypesetDelay, electTypesetter, shouldAdoptRun, cancelsArmedTypeset,
  LOCAL_AUTO_TYPESET_MS, AGENT_AUTO_TYPESET_MS, type TypesetPeer,
  reconnectWatch, runSeesLocalEdits, isNetworkFailure, retypesetOnReconnect, // Galley: V2 integrator
} from '../autoTypeset';

describe('autoTypesetDelay', () => {
  it('arms nothing while the auto-typeset toggle is off', () => {
    expect(autoTypesetDelay({ source: 'local', auto: false, hasTex: true })).toBeNull();
    expect(autoTypesetDelay({ source: 'agent', auto: false, hasTex: true })).toBeNull();
  });

  it('arms nothing in a project with no .tex to typeset', () => {
    expect(autoTypesetDelay({ source: 'local', auto: true, hasTex: false })).toBeNull();
    expect(autoTypesetDelay({ source: 'agent', auto: true, hasTex: false })).toBeNull();
  });

  it('uses the keystroke delay for a local edit and the longer one for an agent edit', () => {
    expect(autoTypesetDelay({ source: 'local', auto: true, hasTex: true })).toBe(LOCAL_AUTO_TYPESET_MS);
    expect(autoTypesetDelay({ source: 'agent', auto: true, hasTex: true })).toBe(AGENT_AUTO_TYPESET_MS);
  });

  it('keeps the agent window longer than the local one', () => {
    // The ordering is the behaviour: an agent that typesets right after its
    // edit must win the race, so this client never runs a second latexmk.
    expect(AGENT_AUTO_TYPESET_MS).toBeGreaterThan(LOCAL_AUTO_TYPESET_MS);
  });
});

describe('electTypesetter', () => {
  const peer = (clientId: number, eligible = true, visible = true): TypesetPeer => ({ clientId, eligible, visible });

  it('elects nobody when there are no peers', () => {
    expect(electTypesetter([])).toBeNull();
  });

  it('elects nobody when no peer is eligible', () => {
    expect(electTypesetter([peer(1, false), peer(2, false)])).toBeNull();
  });

  it('elects the only eligible client', () => {
    expect(electTypesetter([peer(7)])).toBe(7);
  });

  it('never elects an ineligible client, even the lowest id', () => {
    expect(electTypesetter([peer(1, false), peer(9)])).toBe(9);
  });

  it('prefers a visible tab over a lower-id background one', () => {
    expect(electTypesetter([peer(1, true, false), peer(9, true, true)])).toBe(9);
  });

  it('falls back to the lowest id when every tab is in the background', () => {
    expect(electTypesetter([peer(9, true, false), peer(3, true, false)])).toBe(3);
  });

  it('elects the same client whatever order the peers arrive in', () => {
    // Determinism is what removes the round trip: every tab computes the
    // winner locally from the same awareness and they agree without asking.
    const peers = [peer(4, true, false), peer(8), peer(2, false), peer(6)];
    const shuffled = [peers[2], peers[3], peers[0], peers[1]];
    expect(electTypesetter(peers)).toBe(electTypesetter(shuffled));
    expect(electTypesetter(peers)).toBe(6);
  });
});

describe('shouldAdoptRun', () => {
  it('refuses while this client is compiling, even for a newer run', () => {
    expect(shouldAdoptRun(1, 2, true)).toBe(false);
  });

  it('refuses when the server reports no runId (an older server)', () => {
    expect(shouldAdoptRun(1, undefined, false)).toBe(false);
    expect(shouldAdoptRun(undefined, undefined, false)).toBe(false);
  });

  it('adopts a run when the preview shows none yet', () => {
    expect(shouldAdoptRun(undefined, 5, false)).toBe(true);
  });

  it('adopts a newer run and ignores the one already on screen', () => {
    expect(shouldAdoptRun(5, 6, false)).toBe(true);
    expect(shouldAdoptRun(5, 5, false)).toBe(false);
    expect(shouldAdoptRun(5, 4, false)).toBe(false);
  });
});

describe('cancelsArmedTypeset', () => {
  it('cancels the timer for edits the run already contains', () => {
    expect(cancelsArmedTypeset(1_000, 3_000)).toBe(true);
  });
  it('keeps it when the last keystroke may not have reached the server yet', () => {
    expect(cancelsArmedTypeset(2_900, 3_000)).toBe(false);
  });
});

// Galley: V2 integrator: the typeset after a reconnection
describe('reconnectWatch', () => {
  const up = { loaded: true, connected: true, online: true, unsynced: false };
  const down = { ...up, connected: false };

  it('answers once when the link returns after a loss, not on the first connection', () => {
    const w = reconnectWatch();
    expect(w('a', { ...up, loaded: false, connected: false })).toBe(false);
    expect(w('a', up)).toBe(false);
    expect(w('a', down)).toBe(false);
    expect(w('a', up)).toBe(true);
    expect(w('a', up)).toBe(false);
    expect(w('a', { ...up, unsynced: true })).toBe(false);
  });

  it('answers again for each later loss, never twice for one', () => {
    const w = reconnectWatch();
    w('a', up);
    w('a', down); w('a', down);
    expect(w('a', up)).toBe(true);
    w('a', { ...up, online: false });
    expect(w('a', up)).toBe(true);
  });

  it('waits until the edits made meanwhile have reached the server', () => {
    const w = reconnectWatch();
    w('a', up);
    w('a', down);
    expect(w('a', { ...up, unsynced: true })).toBe(false);
    expect(w('a', up)).toBe(true);
  });

  it('counts a page opened offline as a loss', () => {
    const w = reconnectWatch();
    expect(w('a', { loaded: false, connected: false, online: false })).toBe(false);
    expect(w('a', up)).toBe(true);
  });

  it('does not take a new file connecting for a return, but ends a loss that began on the last one', () => {
    const w = reconnectWatch();
    w('a', up);
    expect(w('b', down)).toBe(false);
    expect(w('b', up)).toBe(false);
    w('b', down);
    w('c', { ...down, loaded: false });
    expect(w('c', up)).toBe(true);
  });
});

describe('runSeesLocalEdits', () => {
  it('needs the link up and every edit confirmed', () => {
    expect(runSeesLocalEdits({ loaded: true, connected: true, online: true, unsynced: false })).toBe(true);
    expect(runSeesLocalEdits({ loaded: true, connected: true, online: true, unsynced: true })).toBe(false);
    expect(runSeesLocalEdits({ loaded: true, connected: false, online: true, unsynced: false })).toBe(false);
    expect(runSeesLocalEdits({ loaded: true, connected: true, online: false, unsynced: false })).toBe(false);
  });
  it('is true with no open document', () => {
    expect(runSeesLocalEdits(null)).toBe(true);
  });
});

describe('isNetworkFailure', () => {
  it('names no answer and the gateway statuses, not a refusal or a broken document', () => {
    for (const s of [0, 502, 503, 504]) expect(isNetworkFailure(s)).toBe(true);
    for (const s of [400, 401, 403, 404, 409, 422, 500, undefined]) expect(isNetworkFailure(s)).toBe(false);
  });
});

describe('retypesetOnReconnect', () => {
  const base = { auto: true, hasTex: true, armed: false, running: false, runSees: true, networkFailed: false, lastLocalEditAt: 1_000, coveredAt: 2_000 };

  it('typesets after a typeset that could not reach the server', () => {
    expect(retypesetOnReconnect({ ...base, networkFailed: true })).toBe(true);
  });

  it('typesets when this tab edited after the newest run that saw its edits', () => {
    expect(retypesetOnReconnect({ ...base, lastLocalEditAt: 3_000 })).toBe(true);
  });

  it('does nothing when the preview is current', () => {
    expect(retypesetOnReconnect(base)).toBe(false);
  });

  it('respects the auto-typeset setting and a project with no .tex', () => {
    expect(retypesetOnReconnect({ ...base, networkFailed: true, auto: false })).toBe(false);
    expect(retypesetOnReconnect({ ...base, networkFailed: true, hasTex: false })).toBe(false);
  });

  it('leaves it to a timer that will typeset anyway', () => {
    expect(retypesetOnReconnect({ ...base, networkFailed: true, armed: true })).toBe(false);
  });

  it('queues behind a running typeset only when that run started without the link', () => {
    expect(retypesetOnReconnect({ ...base, networkFailed: true, running: true, runSees: true })).toBe(false);
    expect(retypesetOnReconnect({ ...base, running: true, runSees: false })).toBe(true);
  });
});
