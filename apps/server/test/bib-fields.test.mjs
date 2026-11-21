/**
 * The bibliography index's V2 fields (bib.ts, WP15): the entry's line, and
 * editor, doi, url, eprint, eprinttype, pmid and crossref, for the citation
 * picker, go to definition and link following. Identifiers keep their
 * characters (no dash or tilde rewriting) with TeX escapes undone. Absent
 * fields stay absent, so V1's replies keep their shape.
 */
import { check, eq } from './assert.mjs';
const { parseBib, texText } = await import('../src/bib.ts');

const src = [
  '@string{jacm = {Journal of the ACM}}',           // 1
  '',                                               // 2
  '@article{smith2020,',                            // 3
  '  author = {Smith, Ann},',                       // 4
  '  title = {A title},',                           // 5
  '  doi = {https://doi.org/10.1000/abc--d_e},',    // 6
  '  url = {https://example.org/a\\_b~c?x=1\\%20},',// 7
  '  year = 2020',                                  // 8
  '}',                                              // 9
  '% a comment line',                               // 10
  '@misc{lee2021,',                                 // 11
  '  editor = {M{\\"u}ller, J.},',                  // 12
  '  eprint = {2101.00001},',                       // 13
  '  archivePrefix = {arXiv},',                     // 14
  '  pmid = {12345678},',                           // 15
  '  crossref = {smith2020},',                      // 16
  '  doi = {doi:10.1000/XYZ},',                     // 17
  '  howpublished = {\\url{https://x.org}},',       // 18
  '}',
  '@online{web,',
  '  url = {\\url{https://example.org/w}},',
  '  eprinttype = {PubMed}, eprint = {999},',
  '}',
].join('\r\n');

const [a, b, w] = parseBib(src, 'refs.bib');
eq([a.key, a.line, b.key, b.line, w.line], ['smith2020', 3, 'lee2021', 11, 20], 'each entry has the line of its @type{');
eq(a.doi, '10.1000/abc--d_e', 'a doi.org URL becomes the bare DOI; dashes stay dashes');
eq(a.url, 'https://example.org/a_b~c?x=1%20', 'a URL with TeX escapes undone and its tilde kept');
eq([b.editor, b.eprint, b.eprinttype, b.pmid, b.crossref, b.doi], ['Müller, J.', '2101.00001', 'arxiv', '12345678', 'smith2020', '10.1000/XYZ'], 'editor, eprint, archivePrefix, pmid, crossref, doi: prefix');
check(b.url === undefined, 'howpublished is not url');
eq([w.url, w.eprinttype, w.eprint], ['https://example.org/w', 'pubmed', '999'], 'a \\url{} wrapper is dropped; eprinttype');
for (const k of ['editor', 'doi', 'url', 'eprint', 'eprinttype', 'pmid', 'crossref']) check(!(k in a) || a[k] !== undefined, `${k}: absent fields are left out`);
check(!('editor' in a) && !('pmid' in a), 'an entry without the fields has no such keys');
eq(texText('Caf\\\'e \\emph{x}'), 'Café x', 'texText is the display cleaner');

console.log('bib-fields: ok');
