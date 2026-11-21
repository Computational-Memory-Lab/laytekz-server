/**
 * Running inside the Laytekz desktop app (WP02 settings-core). The shell
 * (WP09) appends ` Laytekz-Desktop/<version>` to the user agent; that token
 * is the whole contract, so a page never needs an API from the shell to know
 * it is there. It identifies the app and nothing more: never treat it as
 * proof of anything, since any client can send it.
 */

export const DESKTOP_UA_TOKEN = 'Laytekz-Desktop';

const TOKEN = new RegExp(`(?:^|\\s)${DESKTOP_UA_TOKEN}/([0-9A-Za-z][0-9A-Za-z.+_-]*)`);

/** The version a user-agent string's token names, or null without one. */
export function parseDesktopVersion(userAgent: string | null | undefined): string | null {
  return (userAgent && TOKEN.exec(userAgent)?.[1]) || null;
}

function userAgent(): string {
  try { return typeof navigator !== 'undefined' ? navigator.userAgent : ''; } catch { return ''; }
}

export function isDesktop(): boolean {
  return desktopVersion() !== null;
}

/** The shell's version from the token, or null outside the desktop app. */
export function desktopVersion(): string | null {
  return parseDesktopVersion(userAgent());
}
