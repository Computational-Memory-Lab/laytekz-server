/**
 * Galley: V2 web readiness (WP45): headers and caching, static 404s, the app
 * page's stamps and report-only CSP, /about, security.txt, the desktopUrl
 * capability, and the waiting-for-approval page's wording.
 *
 * Lives beside the feature because WP45's globs do not cover
 * apps/server/test/ (request R1 in docs/galley-v2/WP45.md moves it there as
 * apps/server/test/web-readiness-http.test.mjs; then SRC becomes '../src/').
 * Run: npx tsx apps/server/src/features/webShell/__tests__/web-readiness-http.test.mjs
 *
 * Env must be set before any src import.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = new URL('../src/', import.meta.url);
const { check, eq } = await import(new URL('../test/assert.mjs', SRC).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-web-readiness-'));
process.env.AUTH_ENABLED = '1';
process.env.ALDINE_SSO_ONLY = '1';
process.env.ALDINE_SIGNUP = 'approval';
process.env.ALDINE_PUBLIC_URL = 'https://latex.example.org';
process.env.ALDINE_INSTANCE_NAME = 'Example Lab';
process.env.ALDINE_SUPPORT = 'help@example.org';
process.env.GALLEY_DESKTOP_URL = 'https://example.org/releases/latest';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.META_DIR = path.join(tmp, 'meta');
process.env.CACHE_DIR = path.join(tmp, 'cache');
process.env.WEB_DIST = path.join(tmp, 'dist');
for (const k of ['DATABASE_URL', 'REDIS_URL', 'SENTRY_DSN', 'ALDINE_BASE_PATH', 'SMTP_HOST', 'AWS_SES_REGION']) delete process.env[k];

const PREPAINT = "\n      (function () { document.documentElement.dataset.theme = 'dark'; })();\n    ";
const CHECK = '\n      (function () { window.__laytekzUnsupported = false; })();\n    ';
const dist = path.join(tmp, 'dist');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), `<!doctype html><html><head><title>Laytekz</title><script data-prepaint>${PREPAINT}</script><script type="module" crossorigin src="./assets/index-abc123.js"></script></head><body><div id="root"></div><script data-browser-check>${CHECK}</script></body></html>\n`);
fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)\n');
fs.writeFileSync(path.join(dist, 'favicon.ico'), Buffer.from([0, 0, 1, 0]));
fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"Laytekz"}');

const { initDb } = await import(new URL('db/index.ts', SRC).href);
await initDb();
const { buildApp } = await import(new URL('app.ts', SRC).href);
const app = await buildApp();
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });

{
  const r = await get('/');
  eq(r.statusCode, 200, 'the app page');
  eq(r.headers['cache-control'], 'no-cache', 'the app page is revalidated on every load');
  eq(r.headers['x-content-type-options'], 'nosniff', 'nosniff');
  eq(r.headers['referrer-policy'], 'strict-origin-when-cross-origin', 'referrer policy');
  check(String(r.headers['permissions-policy']).includes('camera=()'), 'permissions policy');
  eq(r.headers['x-robots-tag'], 'noindex, nofollow', 'never indexed');
  eq(r.headers['content-security-policy'], "frame-ancestors 'none'", 'the enforced policy is unchanged');
  const ro = String(r.headers['content-security-policy-report-only']);
  check(ro.includes(sha(PREPAINT)) && ro.includes(sha(CHECK)), `the report-only CSP hashes both inline scripts exactly (${ro})`);
  check(ro.includes('wss://latex.example.org') && ro.includes('https://huggingface.co'), 'connect-src: the websocket origin and the model hosts');
  const rev = /<meta name="laytekz-rev" content="([0-9a-f]{12})"/.exec(r.body)?.[1];
  check(!!rev, 'the build revision is stamped');
  check(r.body.includes('<meta property="og:url" content="https://latex.example.org/" />'), 'og:url is absolute');
  check(r.body.includes('<meta property="og:image" content="https://latex.example.org/og.png" />'), 'og:image is absolute');
  const caps = (await get('/api/capabilities')).json();
  eq(caps.rev, rev, 'capabilities answer the same revision the page carries');
  eq(caps.desktopUrl, 'https://example.org/releases/latest', 'desktopUrl, signed out too');
}
{
  const r = await get('/p/abcd1234');
  check(String(r.headers['content-type']).startsWith('text/html') && !r.body.includes('abcd1234'), 'a project URL gets the generic page');
  eq(r.headers['cache-control'], 'no-cache', 'app routes are revalidated');
}
{
  const r = await get('/assets/index-abc123.js');
  eq(r.statusCode, 200, 'a hashed asset');
  eq(r.headers['cache-control'], 'public, max-age=31536000, immutable', 'hashed assets are immutable');
  eq(r.headers['x-content-type-options'], 'nosniff', 'static files get the base headers');
}
for (const url of ['/assets/missing-old.js', '/favicon-missing.ico', '/apple-touch-icon-precomposed.png', '/cmaps/none.bcmap', '/sitemap.xml?x=1']) {
  const r = await get(url);
  eq(r.statusCode, 404, `${url}: 404`);
  check(String(r.headers['content-type']).startsWith('application/json'), `${url}: JSON, never the app page`);
  eq(r.headers['cache-control'], 'no-store', `${url}: never cached`);
}
{
  const r = await get('/favicon.ico');
  eq(r.statusCode, 200, 'the icon');
  eq(r.headers['cache-control'], 'public, max-age=86400', 'icons keep a day');
  eq((await get('/manifest.webmanifest')).headers['cache-control'], 'public, max-age=86400', 'the manifest keeps a day');
}
{
  const r = await get('/plugins/references/manifest.json');
  if (r.statusCode === 200) eq(r.headers['cache-control'], 'no-cache', 'plugin files are revalidated');
  const s = await get('/settings/appearance');
  check(String(s.headers['content-type']).startsWith('text/html'), 'an app route without a dot still gets the page');
  eq((await get('/oauth/authorize?redirect_uri=https://x.example/cb.js')).statusCode, 200, 'a query with a dot is not a file');
  check(String((await get('/index.html')).headers['content-type']).startsWith('text/html'), '/index.html is still the app page');
}
{
  const r = await get('/privacy');
  eq(r.headers['x-robots-tag'], 'noindex, nofollow', 'server pages carry X-Robots-Tag');
  eq(r.headers['cache-control'], 'no-store', "a route's own cache-control wins");
}
{
  const r = await get('/about');
  eq(r.statusCode, 200, '/about, signed out');
  check(String(r.headers['content-type']).startsWith('text/html') && !/<script/i.test(r.body), 'script-free page');
  check(String(r.headers['content-security-policy']).includes("default-src 'none'"), 'locked-down policy');
  check(r.body.includes('href="/privacy"') && r.body.includes('data-testid="about-back"'), 'links to privacy and back');
  check(r.body.includes('<strong>Example Lab</strong>') && r.body.includes('mailto:help@example.org'), 'names the operator and the contact');
  check(r.body.includes('approves each new account by hand'), 'explains approval');
  check(r.body.includes('href="https://example.org/releases/latest"'), 'the desktop download');
  check(!r.body.includes('{{') && !r.body.includes('undefined'), 'nothing left unfilled');
}
{
  const r = await get('/.well-known/security.txt');
  eq(r.statusCode, 200, 'security.txt with a contact');
  check(r.body.startsWith('Contact: mailto:help@example.org\nExpires: ') && r.body.includes('Canonical: https://latex.example.org/.well-known/security.txt'), r.body);
}

const pages = await import(new URL('features/webShell/pages.ts', SRC).href);
eq(pages.desktopUrl({ GALLEY_DESKTOP_URL: 'http://example.org/' }), null, 'a non-https desktop URL is unset');
eq(pages.desktopUrl({}), null, 'no desktop URL');
check(!pages.aboutPage({ instance: { name: null, logo: null, logoDark: null, url: null, support: null }, basePath: '/x', approval: false, desktop: null, source: null }).includes('Desktop app'), 'no desktop section without the URL');
eq(pages.securityTxt(null, null), null, 'no security.txt without a contact');
{
  const base = { message: 'Your account is created. An administrator of this server approves new accounts. You can sign in once they have.', account: 'a@b.example', support: { kind: 'email', value: 'help@example.org' }, mailsApproval: false, adminsTold: false, desktop: false, basePath: '' };
  const plain = pages.waitingMain(base);
  check(plain.includes(`data-testid="sign-in-error">${base.message}</p>`), 'the V1 sentence stays under its test id');
  check(plain.includes('<strong>a@b.example</strong>') && plain.includes('mailto:help@example.org'), 'names the address and the contact');
  check(plain.includes('data-testid="sign-in-error-back" href="/"'), 'the way back');
  const mailed = pages.waitingMain({ ...base, mailsApproval: true, adminsTold: true });
  check(mailed.includes('You will get an email at <strong>a@b.example</strong>') && mailed.includes('has been told'), 'with email: what happens next');
  check(pages.waitingMain({ ...base, desktop: true }).includes('go back to the Laytekz desktop app'), 'the desktop wording');
  check(pages.waitingMain({ ...base, account: '<x>@b', support: null }).includes('&#60;x&#62;@b'), 'the address is escaped');
}

await app.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('web-readiness-http: ALL PASSED');
