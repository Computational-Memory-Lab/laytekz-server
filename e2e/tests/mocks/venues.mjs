/** Mock venue kit publisher (see apps/server/src/venuekits.ts) and the venue registry the app server reads. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../../../apps/server/test/zip.mjs';

export const order = 300;

/** A publisher kit, built here rather than committed: no publisher file, and
 *  no file of ours pretending to be one, ever lands in the repo. */
const VENUE_KIT = buildZip({
  'e2e-kit-1.0/e2evenue.sty': '\\ProvidesPackage{e2evenue}\n\\endinput\n',
  'e2e-kit-1.0/e2e-sample.tex': '\\documentclass{article}\n\\usepackage{e2evenue}\n\\begin{document}\nFrom the venue kit.\n\\end{document}\n',
  'e2e-kit-1.0/e2e.bib': '@article{knuth1984,author={Knuth, Donald E.},title={Literate Programming},year={1984}}\n',
  'e2e-kit-1.0/kit-manual.pdf': '%PDF-1.7 not taken\n',
  '__MACOSX/e2e-kit-1.0/._e2evenue.sty': 'junk',
});

export function handle(req, res, { url }) {
  // The registry the app server reads points here, so the kit path is exercised
  // end to end without the suite ever reaching a real publisher.
  if (url.pathname !== '/venue-kit.zip') return false;
  res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(VENUE_KIT.length) });
  res.end(VENUE_KIT);
  return true;
}

/**
 * The venue registry the app server loads (VENUES_FILE in playwright.config).
 * Written here because only this process knows the mock's port; the server
 * re-reads the file when it changes, so the order the two start in does not
 * matter.
 */
export function start({ port }) {
  const venue = (id, name, file) => ({
    id, name, category: 'Conferences',
    description: `${name} submission, used by the e2e suite.`,
    homepage: 'https://example.org/authors',
    termsUrl: 'https://example.org/terms',
    kit: { url: `http://localhost:${port}/${file}`, host: `localhost:${port}`, take: ['e2evenue.sty', 'e2e-sample.tex', 'e2e.bib'] },
    documentClass: 'article',
    preamble: ['\\usepackage{e2evenue}'],
    bibStyle: 'plain',
    main: 'e2e-sample.tex',
  });
  const registry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.data-e2e/venues-e2e.json');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, JSON.stringify({
    venues: [
      venue('e2ekit', 'E2E Venue Kit', 'venue-kit.zip'),
      venue('e2egone', 'E2E Missing Kit', 'no-such-kit.zip'),
      // A publisher that only hands its kit to a browser: the tile imports, it never creates.
      (() => { const v = venue('e2ehand', 'E2E Manual Kit', 'venue-kit.zip'); v.kit.manual = true; return v; })(),
    ],
  }, null, 2));
}
