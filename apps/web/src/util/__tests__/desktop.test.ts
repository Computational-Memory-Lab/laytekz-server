import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_UA_TOKEN, desktopVersion, isDesktop, parseDesktopVersion } from '../desktop';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

afterEach(() => { vi.unstubAllGlobals(); });

describe('the desktop app’s user-agent token', () => {
  it('reads the version the shell appends', () => {
    expect(parseDesktopVersion(`${CHROME} ${DESKTOP_UA_TOKEN}/2.0.0`)).toBe('2.0.0');
    expect(parseDesktopVersion(`${CHROME} Laytekz-Desktop/2.1.0-beta.3 Electron/37.2.0`)).toBe('2.1.0-beta.3');
  });

  it('finds nothing in a browser, or in a look-alike', () => {
    expect(parseDesktopVersion(CHROME)).toBeNull();
    expect(parseDesktopVersion(`${CHROME} XLaytekz-Desktop/2.0.0`)).toBeNull();
    expect(parseDesktopVersion(`${CHROME} Laytekz-Desktop/`)).toBeNull();
    expect(parseDesktopVersion('')).toBeNull();
    expect(parseDesktopVersion(undefined)).toBeNull();
  });

  it('answers from navigator.userAgent', () => {
    vi.stubGlobal('navigator', { userAgent: `${CHROME} Laytekz-Desktop/2.0.0` });
    expect(isDesktop()).toBe(true);
    expect(desktopVersion()).toBe('2.0.0');
    vi.stubGlobal('navigator', { userAgent: CHROME });
    expect(isDesktop()).toBe(false);
    expect(desktopVersion()).toBeNull();
  });
});
