/**
 * AGPL section 13: anyone interacting with this instance over a network must
 * be offered the source of the version they are interacting with. The server
 * stamps where that is into index.html (apps/server/src/galley-source.ts:
 * GALLEY_SOURCE_URL, or its own /source.tar.gz); without the stamp it is
 * this fork's public repository, never upstream's, whose code this is not.
 */
import { FORK_SOURCE_URL, UPSTREAM_URL } from './product';

export const UPSTREAM_SOURCE_URL = UPSTREAM_URL;
export const DEFAULT_SOURCE_URL = FORK_SOURCE_URL;

/** The stamped link when it is an http(s) URL or a path on this origin, else null. */
export function parseSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return /^https?:\/\/[^\s]+$/i.test(raw) ? raw : null;
}

function readSourceUrl(): string | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="galley-source"]') as HTMLMetaElement | null;
  return parseSourceUrl(meta?.content);
}

const stamped = readSourceUrl();
/** Where "Source code" and "Get the source" lead. */
export const SOURCE_URL = stamped ?? DEFAULT_SOURCE_URL;
/** The instance names its own source, so upstream's is shown beside it as the project it is based on. */
export const SOURCE_IS_DEPLOYMENT = stamped !== null;
