/**
 * Laytekz V2 (WP35): operator configuration of the reference-manager
 * libraries. Read on every call, so tests can set the environment after
 * import. Everything is optional: with nothing set, Zotero works by pasted
 * API key, Mendeley is hidden, and the desktop app can push a local .bib.
 */

export interface LibrariesConfig {
  zoteroApi: string;
  /** Zotero's OAuth 1.0a pages and endpoints (https://www.zotero.org/oauth). */
  zoteroOAuthBase: string;
  zoteroOAuth: { key: string; secret: string } | null;
  mendeleyApi: string;
  mendeleyOAuthBase: string;
  mendeley: { id: string; secret: string } | null;
  /** Links per project (plan: at most 5). */
  maxLinks: number;
  /** Desktop pushes (PUT …/content), in bytes. */
  contentMaxBytes: number;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export function librariesConfig(): LibrariesConfig {
  const e = process.env;
  const zk = (e.ZOTERO_OAUTH_CLIENT_KEY || '').trim();
  const zs = (e.ZOTERO_OAUTH_CLIENT_SECRET || '').trim();
  const mi = (e.MENDELEY_CLIENT_ID || '').trim();
  const ms = (e.MENDELEY_CLIENT_SECRET || '').trim();
  return {
    zoteroApi: trimSlash(e.ZOTERO_API_BASE || 'https://api.zotero.org'),
    zoteroOAuthBase: trimSlash(e.ZOTERO_OAUTH_BASE || 'https://www.zotero.org/oauth'),
    zoteroOAuth: zk && zs ? { key: zk, secret: zs } : null,
    mendeleyApi: trimSlash(e.MENDELEY_API_BASE || 'https://api.mendeley.com'),
    mendeleyOAuthBase: trimSlash(e.MENDELEY_OAUTH_BASE || 'https://api.mendeley.com/oauth'),
    mendeley: mi && ms ? { id: mi, secret: ms } : null,
    maxLinks: 5,
    contentMaxBytes: 20 * 1024 * 1024,
  };
}
