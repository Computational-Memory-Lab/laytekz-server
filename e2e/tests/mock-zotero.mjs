/**
 * Mock upstreams for the e2e suites (Zotero, reference sources, Anthropic, a
 * venue kit host, and the V2 mocks): a router over tests/mocks/*.mjs. The
 * file keeps its V1 name because the Playwright configs and specs refer to it.
 *
 * Each mocks/<name>.mjs (a leading '_' skips the file) exports:
 *   handle(req, res, ctx) -> boolean | Promise<boolean>   true: it answered
 *   order?: number   ascending; default 500. zotero.mjs is 1000 and answers
 *                    every remaining path (403 without its key), so a new mock
 *                    must sort before it and claim its own path prefix.
 *   start?(ctx)      once, before the server listens
 * ctx: { port, url: URL (the request's, base http://x), send(code, body, headers) }
 * `send` writes a string as text/plain and anything else as JSON.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const port = Number(process.env.E2E_MOCK_PORT || 4919);
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mocks');

const mocks = [];
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
  const m = await import(pathToFileURL(path.join(dir, file)).href);
  if (typeof m.handle !== 'function') throw new Error(`[mock-zotero] mocks/${file} exports no handle()`);
  mocks.push({ file, order: typeof m.order === 'number' ? m.order : 500, handle: m.handle, start: m.start });
}
mocks.sort((a, b) => a.order - b.order || (a.file < b.file ? -1 : 1));

const sender = (res) => (code, body, headers = {}) => {
  const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(code, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(buf);
};

for (const m of mocks) if (m.start) await m.start({ port });

const server = http.createServer(async (req, res) => {
  const ctx = { port, url: new URL(req.url, 'http://x'), send: sender(res) };
  try {
    for (const m of mocks) if (await m.handle(req, res, ctx)) return;
    ctx.send(404, { error: 'not found' });
  } catch (err) {
    console.error(`[mock-zotero] ${req.method} ${req.url}:`, err);
    if (!res.headersSent) ctx.send(500, { error: 'mock failed' });
    else res.end();
  }
});

server.listen(port, () => console.log(`[mock-zotero] on :${port}`));
