/**
 * Galley: the product's own name and credit, in one place. Upstream's UI calls
 * itself Aldine; TRADEMARK.md asks a modified version to use a name of its own
 * and say "based on Aldine". Every user-visible product name in the web app
 * comes from here. Machine names stay upstream's: ALDINE_* variables, the
 * aldine.* storage keys, cookie and header names, API fields, the git author.
 *
 * The server's copy is apps/server/src/product.ts, and index.html carries the
 * name as plain text (nothing runs before it); __tests__/product.test.ts keeps
 * the three in step.
 */
export const PRODUCT_NAME = 'Laytekz';

/** The sign-in card's line under the wordmark, and About's description. */
export const PRODUCT_LINE = 'Write LaTeX together with a live PDF preview.';

/** Where this fork's own source is published. Aldine's repository is not the
 *  source of this modified version, so it is never the fallback for "Source code". */
export const FORK_SOURCE_URL = 'https://github.com/Computational-Memory-Lab/laytekz-server';

export const UPSTREAM_NAME = 'Aldine';
export const UPSTREAM_URL = 'https://github.com/trahloff/Aldine';
/** Upstream's copyright (README.md, "License"), shown in About after the credit: "Aldine © …". */
export const UPSTREAM_COPYRIGHT = '© 2026 Tobias Rahloff';

/** The privacy page the server renders (apps/server/src/privacy.ts); pass through withBase. */
export const PRIVACY_PATH = '/privacy';

/**
 * An operator name (ALDINE_INSTANCE_NAME) that only repeats the product's
 * adds nothing beside it ("Laytekz · Laytekz"). Such a name counts as unset.
 */
export function isProductName(name: string | null | undefined): boolean {
  return !!name && name.trim().toLowerCase() === PRODUCT_NAME.toLowerCase();
}
