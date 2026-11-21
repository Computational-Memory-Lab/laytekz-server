/**
 * Galley: an old host name redirects to ALDINE_PUBLIC_URL (galley-canonical-host.ts).
 */
import Fastify from 'fastify';
import { check, eq } from './assert.mjs';

const { canonicalTarget, hostName, registerCanonicalHost } = await import('../src/galley-canonical-host.ts');

eq(hostName('Latex.Example.org:443'), 'latex.example.org', 'host without port, lower case');
eq(hostName('[::1]:3040'), '[::1]', 'an IPv6 literal');
const pub = 'https://laytekz.example.org';
eq(canonicalTarget(pub, 'latex.example.org', '/p/abc?branch=main'), 'https://laytekz.example.org/p/abc?branch=main', 'an old name goes to the same path');
eq(canonicalTarget(pub, 'laytekz.example.org', '/'), null, 'the public name is served');
for (const h of ['127.0.0.1', 'localhost', '[::1]', '']) eq(canonicalTarget(pub, h, '/api/health'), null, `loopback "${h}" is served`);

const app = Fastify();
registerCanonicalHost(app, { GALLEY_CANONICAL_HOST_REDIRECT: '1', ALDINE_PUBLIC_URL: pub });
app.get('/api/health', async () => ({ ok: true }));
app.post('/api/x', async () => ({ ok: true }));
await app.ready();
let r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'latex.example.org' } });
eq(r.statusCode, 308, 'old name: permanent redirect');
eq(r.headers.location, 'https://laytekz.example.org/api/health', 'to the same path');
r = await app.inject({ method: 'POST', url: '/api/x', headers: { host: 'latex.example.org' } });
eq(r.statusCode, 308, 'a POST keeps its method (308)');
r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: '127.0.0.1:3040' } });
eq(r.statusCode, 200, 'health checks over loopback are served');
r = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'laytekz.example.org' } });
eq(r.statusCode, 200, 'the public name is served');
await app.close();

const off = Fastify();
registerCanonicalHost(off, { ALDINE_PUBLIC_URL: pub });
off.get('/', async () => 'ok');
r = await off.inject({ method: 'GET', url: '/', headers: { host: 'other.example.org' } });
check(r.statusCode === 200, 'off unless GALLEY_CANONICAL_HOST_REDIRECT=1');
await off.close();
console.log('galley-canonical-host: all assertions passed');
