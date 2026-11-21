import { useEffect } from 'react';
import { INSTANCE } from '../instance';
import { isProductName, PRODUCT_NAME } from '../product';

/** "Projects – Laytekz", or "Projects – Laytekz · Kiel University" when the operator named itself.
 *  Galley: the product's own name (product.ts), not Aldine's. */
export function documentTitle(page?: string | null, operator: string | null | undefined = INSTANCE?.name): string {
  const app = operator && !isProductName(operator) ? `${PRODUCT_NAME} · ${operator}` : PRODUCT_NAME;
  return page ? `${page} – ${app}` : app;
}

/** The browser tab says which page this is: "Projects – Laytekz". */
export function useDocumentTitle(page: string | null | undefined): void {
  useEffect(() => { document.title = documentTitle(page); }, [page]);
}
