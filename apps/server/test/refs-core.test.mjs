/**
 * WP16 reference lookup, the pure parts: what a query is (identify), the
 * three key styles and collision suffixes (keys), capital protection, field
 * mapping and metadata → entry (bibtex), and one result per paper plus the
 * same-paper check that fixes the key-collision bug (merge).
 */
import { check, eq } from './assert.mjs';

const { identify, normalizeIsbn } = await import('../src/refs/identify.ts');
const { makeKey, uniqueKey, firstSurname, asciiFold } = await import('../src/refs/keys.ts');
const { protectTitle, applyFieldStyle, cslToEntry, parseEntry, firstEntryText } = await import('../src/refs/bibtex.ts');
const { mergeCandidates, findSamePaper, titleSimilarity } = await import('../src/refs/merge.ts');

// ---- identify ----
const id = (q) => { const r = identify(q); return `${r.kind}:${r.value}`; };
eq(id('10.1145/3442188.3445922'), 'doi:10.1145/3442188.3445922', 'a bare DOI');
eq(id('doi:10.1038/nature14539.'), 'doi:10.1038/nature14539', 'doi: prefix and a trailing full stop');
eq(id('https://doi.org/10.1002/(SICI)1097-4636(199706)35:4<513::AID-JBM12>3.0.CO;2-E'), 'doi:10.1002/(SICI)1097-4636(199706)35:4<513::AID-JBM12>3.0.CO;2-E', 'a doi.org URL keeps balanced brackets');
eq(id('https://dx.doi.org/10.1000/xyz123)'), 'doi:10.1000/xyz123', 'an unbalanced closing bracket is punctuation');
eq(id('1706.03762'), 'arxiv:1706.03762', 'a bare new-style arXiv id as the whole query');
eq(id('arXiv:1706.03762v5'), 'arxiv:1706.03762', 'versions are dropped');
eq(id('https://arxiv.org/abs/2301.01234v2'), 'arxiv:2301.01234', 'an abs URL');
eq(id('https://arxiv.org/pdf/2301.01234.pdf'), 'arxiv:2301.01234', 'a pdf URL');
eq(id('hep-th/9901001'), 'arxiv:hep-th/9901001', 'an old-style id');
eq(id('arXiv:math.GT/0309136'), 'arxiv:math.GT/0309136', 'an old-style id with a subject class');
eq(identify('scaling laws 2023.12345 tokens').kind, 'text', 'a 2023.12345 inside text is not arXiv');
eq(id('PMID: 31452104'), 'pmid:31452104', 'a PMID');
eq(id('https://pubmed.ncbi.nlm.nih.gov/31452104/'), 'pmid:31452104', 'a PubMed URL');
eq(id('PMC6851433'), 'pmcid:PMC6851433', 'a PMCID');
eq(id('978-0-262-03384-8'), 'isbn:9780262033848', 'an ISBN-13 with hyphens');
eq(id('ISBN 0-306-40615-2'), 'isbn:0306406152', 'an ISBN-10');
eq(normalizeIsbn('978-0-262-03384-9'), null, 'a bad checksum is refused');
eq(identify('978-0-262-03384-9').kind, 'text', 'and is not an ISBN');
eq(id('openalex:W2741809807'), 'openalex:W2741809807', 'an OpenAlex id');
eq(identify('@article{x, title={T}}').kind, 'bibtex', 'pasted BibTeX');
eq(identify('Vaswani, A., Shazeer, N., Parmar, N. (2017). Attention is all you need. In Advances in Neural Information Processing Systems.').kind, 'citation', 'a formatted citation');
eq(identify('attention is all you need').kind, 'text', 'a title');

// ---- keys ----
const fields = (o) => Object.entries(o).map(([name, value]) => ({ name, value, bare: false }));
const vaswani = fields({ title: 'Attention Is All You Need', author: 'Vaswani, Ashish and Shazeer, Noam', year: '2017' });
eq(makeKey(vaswani, 'authoryear'), 'vaswani2017', 'authoryear');
eq(makeKey(vaswani, 'scholar'), 'vaswani2017attention', 'Scholar');
eq(makeKey(vaswani, 'bbt'), 'vaswaniAttentionAllYou2017', 'Better BibTeX');
eq(makeKey(fields({ title: 'Über Dinge', author: 'M{\\"u}ller, Karl', year: '1999' })), 'muller1999', 'TeX accents fold');
eq(makeKey(fields({ title: 'X', author: 'Müller, Karl', year: '1999' })), 'muller1999', 'Unicode accents fold');
eq(makeKey(fields({ title: 'Report', author: '{World Health Organization}', year: '2020' })), 'world2020', 'a corporate author gives its first significant word');
eq(firstSurname('van der Berg, J.'), 'berg', 'particles are dropped');
eq(makeKey(fields({ title: 'The Anonymous Paper' })), 'anonymous', 'no author or year: a title word');
eq(asciiFold('Łukasz Øster'), 'LukaszOster', 'letters NFD cannot split');
eq(uniqueKey('smith2020', ['Smith2020']), 'smith2020a', 'a taken key (any case) gets a suffix');
eq(uniqueKey('smith2020', ['smith2020', 'smith2020a']), 'smith2020b', 'the next free suffix');
eq(uniqueKey('vaswaniAttentionAllYou2017', ['vaswaniAttentionAllYou2017'], fields({ title: 'Attention Is All You Need', year: '2017' }), 'bbt'), 'vaswaniAttentionAllYouNeed2017', 'BBT tries a fourth title word first');

// ---- bibtex ----
eq(protectTitle('BERT: Pre-training of Deep Bidirectional Transformers'), '{BERT}: Pre-training of Deep Bidirectional Transformers', 'an all-caps word is braced');
eq(protectTitle('Training on ImageNet with mRNA and COVID-19'), 'Training on {ImageNet} with {mRNA} and {COVID-19}', 'internal capitals are braced');
eq(protectTitle('Already {BERT} and $O(N)$ and \\LaTeX{} A'), 'Already {BERT} and $O(N)$ and \\LaTeX{} A', 'braces, math and macros are left alone');
const bl = '@article{k,\n  title = {T},\n  journaltitle = {J},\n  date = {2019-03-01},\n}';
const asBibtex = parseEntry(applyFieldStyle(bl, 'bibtex'));
eq(asBibtex.fields.map((f) => `${f.name}=${f.value}`), ['title=T', 'year=2019', 'journal=J', 'month=mar'], 'biblatex → BibTeX: journal, year and month');
const asBiblatex = parseEntry(applyFieldStyle('@article{k,\n  title = {T},\n  journal = {J},\n  year = {2019},\n}', 'biblatex'));
check(asBiblatex.fields.some((f) => f.name === 'journaltitle'), 'BibTeX → biblatex: journaltitle');
const conf = cslToEntry({ type: 'proceedings-article', title: 'A Paper', author: [{ family: 'Doe', given: 'Jane' }], year: 2020, containerTitle: 'Proc. of X', pages: '1-10', doi: '10.1/x' });
check(conf.startsWith('@inproceedings{') && /booktitle\s+= \{Proc\. of X\}/.test(conf) && /pages\s+= \{1--10\}/.test(conf), `proceedings-article becomes @inproceedings with a booktitle (got ${conf})`);
check(cslToEntry({ type: 'dataset', title: 'D' }, 'biblatex').startsWith('@dataset{') && cslToEntry({ type: 'dataset', title: 'D' }, 'bibtex').startsWith('@misc{'), 'a dataset is @dataset in biblatex and @misc in BibTeX');
check(cslToEntry({ type: 'chapter', title: 'C', containerTitle: 'B' }).startsWith('@incollection{'), 'a chapter is @incollection');
eq(firstEntryText('% from Scholar\n@string{x = "y"}\n@inproceedings{vaswani2017attention,\n  title={Attention is all you need},\n  year={2017}\n}\ntrailing'), '@inproceedings{vaswani2017attention,\n  title={Attention is all you need},\n  year={2017}\n}', 'the first real entry of a pasted blob');

// ---- merge ----
const c = (o) => ({ authors: [], year: null, venue: '', rank: 0, ...o });
const merged = mergeCandidates([
  [c({ id: 'a', source: 'openalex', title: 'Attention Is All You Need', authors: ['Ashish Vaswani'], year: 2017, doi: '10.48550/arXiv.1706.03762', arxiv: '1706.03762', preprint: true, rank: 0 }),
   c({ id: 'b', source: 'openalex', title: 'Deep learning', authors: ['Yann LeCun'], year: 2015, doi: '10.1038/NATURE14539', rank: 1 })],
  [c({ id: 'c', source: 'crossref', title: 'Deep Learning', authors: ['Yann LeCun'], year: 2015, doi: '10.1038/nature14539', rank: 0 }),
   c({ id: 'd', source: 'crossref', title: 'Attention is all you need', authors: ['Ashish Vaswani'], year: 2017, venue: 'NeurIPS', doi: '10.5555/3295222.3295349', rank: 1 })],
]);
eq(merged.length, 2, `the same DOI from two sources is one result, and a preprint clusters with its published version (got ${JSON.stringify(merged.map((m) => m.title))})`);
const att = merged.find((m) => /attention/i.test(m.title));
eq([att.doi, att.arxiv, att.preprint], ['10.5555/3295222.3295349', '1706.03762', false], 'the published version leads and keeps the preprint id');
check(titleSimilarity('Attention Is All You Need', 'Attention is all you need.') === 1, 'titles compare without case or punctuation');

// the key-collision bug: a matching key alone is not the same paper
const bib = '@article{smith2020,\n  title = {Graph Methods for Sparse Data},\n  author = {Smith, Ann},\n  year = {2020},\n  doi = {10.1000/a},\n}\n';
eq(findSamePaper(bib, '@article{smith2020,\n  title = {Protein Folding at Scale},\n  author = {Smith, Bob},\n  year = {2020},\n  doi = {10.1000/b},\n}'), null, 'another Smith 2020 paper is not a duplicate');
eq(findSamePaper(bib, '@article{other,\n  title = {Whatever},\n  doi = {10.1000/A},\n}')?.key, 'smith2020', 'the same DOI (any case) is');
eq(findSamePaper(bib, '@misc{x,\n  title = {Graph methods for sparse data},\n  author = {Smith, A.},\n  year = {2021},\n}')?.key, 'smith2020', 'a near-identical title, year within one, same surname: the same paper');
eq(findSamePaper(bib, '@misc{x,\n  title = {Graph methods for sparse data},\n  author = {Jones, A.},\n  year = {2020},\n}'), null, 'a different first author is not');
eq(findSamePaper('@misc{vaswani2017,\n  title = {Attention},\n  eprint = {1706.03762},\n}\n', '@misc{v,\n  title = {Attention},\n  doi = {10.48550/arXiv.1706.03762},\n}')?.key, 'vaswani2017', 'an arXiv DOI matches an eprint field');

console.log('refs-core tests passed');
