import { describe, expect, it, vi } from 'vitest';
import { createVersionCheck, pageRevision, MIN_GAP_MS, UPDATE_TEXT, type VersionCheckDeps } from '../versionCheck';
import { desktopLinkLabel, desktopUrlOf, waitingLabel } from '../api';
import { gatewayMessage } from '../../../api';
import { settings } from '../settings';

function deps(over: Partial<VersionCheckDeps> = {}) {
  let t = 1_000_000;
  const notify = vi.fn();
  const reload = vi.fn();
  const d: VersionCheckDeps = {
    own: 'aaa111',
    fetchRev: async () => 'aaa111',
    enabled: () => true,
    notify,
    reload,
    now: () => t,
    ...over,
  };
  return { d, notify, reload, advance: (ms: number) => { t += ms; } };
}

describe('version check', () => {
  it('says nothing while the server serves this build', async () => {
    const { d, notify } = deps();
    expect(await createVersionCheck(d).check(true)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it('tells once per new revision, with a Reload action that reloads', async () => {
    const { d, notify, reload, advance } = deps({ fetchRev: async () => 'bbb222' });
    const vc = createVersionCheck(d);
    expect(await vc.check(true)).toBe('bbb222');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe(UPDATE_TEXT);
    advance(MIN_GAP_MS + 1);
    expect(await vc.check()).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    notify.mock.calls[0][1].run();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('a second deploy is told again', async () => {
    let rev = 'bbb222';
    const { d, notify } = deps({ fetchRev: async () => rev });
    const vc = createVersionCheck(d);
    await vc.check(true);
    rev = 'ccc333';
    await vc.check(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('is off with the setting off, without a stamped revision, and when the server cannot be reached', async () => {
    for (const over of [{ enabled: () => false }, { own: '' }, { fetchRev: async () => { throw new Error('offline'); } }, { fetchRev: async () => '' }]) {
      const { d, notify } = deps({ fetchRev: async () => 'bbb222', ...over });
      expect(await createVersionCheck(d).check(true)).toBeNull();
      expect(notify).not.toHaveBeenCalled();
    }
  });

  it('does not ask again within the gap unless forced', async () => {
    const fetchRev = vi.fn(async () => 'aaa111');
    const { d, advance } = deps({ fetchRev });
    const vc = createVersionCheck(d);
    await vc.check();
    await vc.check();
    expect(fetchRev).toHaveBeenCalledTimes(1);
    await vc.check(true);
    expect(fetchRev).toHaveBeenCalledTimes(2);
    advance(MIN_GAP_MS + 1);
    await vc.check();
    expect(fetchRev).toHaveBeenCalledTimes(3);
  });

  it('reads the revision the server stamped into the page', () => {
    const doc = { querySelector: (s: string) => (s === 'meta[name="laytekz-rev"]' ? { getAttribute: () => ' abc123 ' } : null) } as unknown as Document;
    expect(pageRevision(doc)).toBe('abc123');
    expect(pageRevision({ querySelector: () => null } as unknown as Document)).toBe('');
    expect(pageRevision(null)).toBe('');
  });
});

describe('desktop download link', () => {
  it('is hidden inside the desktop app and labelled per platform', () => {
    expect(desktopLinkLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0 Electron/45.4.1 Safari/537.36')).toBeNull();
    expect(desktopLinkLabel('Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Laytekz-Desktop/2.0.0')).toBeNull();
    expect(desktopLinkLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Download the desktop app for macOS');
    expect(desktopLinkLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36')).toBe('Download the desktop app for Windows');
    expect(desktopLinkLabel('Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0')).toBe('Get the desktop app for macOS and Windows');
    expect(desktopLinkLabel('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) Safari/604.1')).toBe('Get the desktop app for macOS and Windows');
  });

  it('takes only an https capability', () => {
    expect(desktopUrlOf({ desktopUrl: 'https://example.org/releases/latest' })).toBe('https://example.org/releases/latest');
    expect(desktopUrlOf({ desktopUrl: 'http://example.org/' })).toBeNull();
    expect(desktopUrlOf({ desktopUrl: 'javascript:alert(1)' })).toBeNull();
    expect(desktopUrlOf({})).toBeNull();
  });
});

describe('admin chip', () => {
  it('counts the waiting accounts and hides at zero', () => {
    expect(waitingLabel(0)).toBeNull();
    expect(waitingLabel(1)).toBe('1 waiting');
    expect(waitingLabel(3)).toBe('3 waiting');
    expect(waitingLabel(Number.NaN)).toBeNull();
  });
});

describe('gateway errors', () => {
  it('names Cloudflare 520–530 answers plainly, and a slow typeset by its limit', () => {
    expect(gatewayMessage('/api/projects/abc/files', 530)).toBe('The server is not responding.');
    expect(gatewayMessage('/api/projects/abc/files', 524)).toBe('The server is not responding.');
    expect(gatewayMessage('/api/projects/abc/compile', 524)).toMatch(/longer than the 100 seconds/);
  });
});

describe('settings', () => {
  it('has an off switch for the update notice, on by default', () => {
    const s = settings.find((d) => d.id === 'webShell.updateNotice');
    expect(s?.default).toBe(true);
    expect(s?.control.kind).toBe('switch');
    expect(s?.validate(false)).toBe(true);
    expect(s?.validate('no')).toBe(false);
  });
});
