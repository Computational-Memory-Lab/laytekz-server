/**
 * Galley: the product's own name and credit, in one place. Upstream calls the
 * product Aldine; TRADEMARK.md asks a modified version to use a name of its
 * own and say "based on Aldine". Every user-visible product name the server
 * writes (pages, emails, messages people read, text it puts into projects)
 * comes from here. Machine names stay upstream's: ALDINE_* variables, cookie
 * and header names, API fields, the git author, the [aldine] log prefix.
 *
 * The web app's copy is apps/web/src/product.ts (its product.test.ts checks
 * that the two agree). No imports: the PDF viewer bundle (viewer/) uses it too.
 */
export const PRODUCT_NAME = 'Laytekz';

/** What the product is, to finish a sentence: "Laytekz, a collaborative LaTeX editor". */
export const PRODUCT_KIND = 'a collaborative LaTeX editor';

export const UPSTREAM_NAME = 'Aldine';
export const UPSTREAM_URL = 'https://github.com/trahloff/Aldine';

/**
 * An operator name (ALDINE_INSTANCE_NAME) that only repeats the product's
 * adds nothing beside it ("Laytekz · Laytekz"). Such a name counts as unset.
 */
export function isProductName(name: string | null | undefined): boolean {
  return !!name && name.trim().toLowerCase() === PRODUCT_NAME.toLowerCase();
}

/** The product, then the operator when it named itself: "Laytekz · Kiel University". */
export function productTitle(operator: string | null | undefined): string {
  return operator && !isProductName(operator) ? `${PRODUCT_NAME} · ${operator}` : PRODUCT_NAME;
}
