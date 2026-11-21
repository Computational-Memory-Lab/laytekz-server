/** Types for core.js, so the web app's unit tests can import it under strict TypeScript. */
export interface Candidate {
  id: string;
  title?: string;
  authors?: string[] | string;
  year?: number | string | null;
  venue?: string | null;
  doi?: string; arxiv?: string; pmid?: string; isbn?: string;
  preprint?: boolean; publishedDoi?: string; weak?: boolean; bibtex?: string;
  inProject?: { key: string; bibFile: string } | null;
}
export interface BibTarget { path: string; exists: boolean; loaded: boolean; synced: boolean; editable: boolean }
export declare const looksLikeBibtex: (text: unknown) => boolean;
export declare const MIN_SEARCH: number;
export declare function undefinedCitations(result: { errors?: Array<{ message?: string }>; log?: string } | null | undefined): string[];
export declare function keyToQuery(key: string): string;
export declare function setEntryKey(bibtex: string, key: string): string;
export declare function entryKey(bibtex: string): string;
export declare const validKey: (key: string) => boolean;
export declare function authorLine(authors: string[] | string | undefined): string;
export declare function byline(c: Candidate | null | undefined): string;
export declare function badges(c: Candidate | null | undefined): Array<{ text: string; kind: 'id' | 'note' | 'project' | 'warn' }>;
export declare function previewBody(c: Candidate | null | undefined): { bibtex: string } | { id: string | undefined };
export declare function targetChoices(targets: BibTarget[] | null | undefined, def: string): BibTarget[];
export declare function newBibPath(text: string): string;
export declare function addedText(o: { key: string; bibFile: string; duplicate?: boolean; cited?: boolean; citeResult?: string | false | null }): string;
export declare function undoneText(o: { entry?: boolean | null; cite?: boolean | null }): string;
