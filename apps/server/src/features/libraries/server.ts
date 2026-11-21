/**
 * Laytekz V2 (WP35): reference-manager libraries, server side (feature 8).
 *
 * Account connections (the signed-in person's own; never a bearer token):
 *   GET|PUT|DELETE /api/libraries/:provider/connection   Zotero: PUT {apiKey}; Mendeley connects by OAuth
 *   GET  /api/libraries/:provider/libraries               My Library and groups
 *   GET  /api/libraries/:provider/collections?library=    collections / folders, with paths
 *   GET  /api/libraries/:provider/search?library=&q=      items from the person's own library, each with its entry
 *   GET  /api/libraries/:provider/connect?return=         OAuth start (302), when the operator set it up
 *   GET  /api/libraries/mendeley/callback                 OAuth 2 callback (a GET: passes the origin check)
 *   GET  /api/libraries/zotero/oauth/callback             OAuth 1.0a callback
 * Project links:
 *   GET    /api/projects/:id/libraries                     every link, for anyone who can open the project
 *   POST   /api/projects/:id/libraries                     link my library to a .bib of my own (members who can edit)
 *   PATCH  /api/projects/:id/libraries/:linkId             change it (its linker or the owner)
 *   DELETE /api/projects/:id/libraries/:linkId             unlink (its linker or the owner); the file stays
 *   POST   /api/projects/:id/libraries/:linkId/sync        {jobId}: any member who can edit
 *   GET    /api/projects/:id/libraries/jobs/:jobId         {state, result?, renamedKeys?, error?}
 *   PUT    /api/projects/:id/libraries/:linkId/content     the desktop app's push of a local .bib (its linker; 20 MB)
 *   POST   /api/projects/:id/libraries/update-citations    {renames:[{from,to}]}: rewrite renamed keys in the .tex files
 */
import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RouteKit, ServerFeature } from '../types.js';
import type { ProjectMeta } from '../../db/types.js';
import * as auth from '../../auth.js';
import * as store from '../../store.js';
import * as zotero from '../../zotero.js';
import { config } from '../../config.js';
import { isOwner } from '../../authz.js';
import { editorOf } from '../../activity.js';
import { ensureWorktree } from '../../gitops.js';
import { subkey } from '../../output-signing.js';
import { BRANCH_RE, importPath, isHiddenPath, publicBase, rootSiblingPath } from '../../util.js';
import { asciiFold, validKey } from '../../refs/keys.js';
import { librariesConfig } from '../../refs/config-libraries.js';
import { LIBRARY_RE, COLLECTION_RE, zoteroOAuthFinish, zoteroOAuthStart, zoteroProvider } from '../../refs/providers/zotero.js';
import { MENDELEY_FOLDER_RE, MENDELEY_LIBRARY_RE, mendeleyAuthorizeUrl, mendeleyConnect, mendeleyProvider } from '../../refs/providers/mendeley.js';
import { LibraryAccessError, NotConnectedError, PROVIDER_IDS, PROVIDER_LABEL, type ProviderId } from '../../refs/providers/types.js';
import {
  DEFAULT_OMIT, LIBRARIES_SIGNAL, LINKS_KEY, LINK_ID_RE, OMIT_GROUPS,
  accountName, dropState, getJob, linkStatus, pausedReason, projectLinks, providerFor, pushContent, readState,
  startSyncJob, storedLinks, syncLink, updateCitations, validLinks, writeState,
  type LibraryLink, type OmitGroup,
} from '../../refs/link.js';

type Req = FastifyRequest<any>;

const accountProvider = (id: unknown) => (id === 'zotero' ? zoteroProvider : id === 'mendeley' ? mendeleyProvider : null);

function validLibrary(provider: ProviderId, library: unknown): library is string {
  if (provider === 'zotero') return typeof library === 'string' && LIBRARY_RE.test(library);
  if (provider === 'mendeley') return typeof library === 'string' && MENDELEY_LIBRARY_RE.test(library);
  return library === undefined || library === '';
}
function validCollection(provider: ProviderId, c: unknown): boolean {
  if (c === undefined || c === null || c === '') return true;
  return typeof c === 'string' && (provider === 'zotero' ? COLLECTION_RE.test(c) : MENDELEY_FOLDER_RE.test(c));
}
const validOmit = (v: unknown): v is OmitGroup[] => Array.isArray(v) && v.length <= OMIT_GROUPS.length && v.every((g) => (OMIT_GROUPS as readonly unknown[]).includes(g));

/** A .bib path a link may write: relative, inside the project, not hidden. */
function cleanBibPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 300) return null;
  const p = importPath(raw.trim());
  return p && /\.bib$/i.test(p) && !isHiddenPath(p) ? p : null;
}

function upstream(reply: FastifyReply, err: unknown) {
  if (err instanceof NotConnectedError) return reply.code(400).send({ error: err.message, code: 'not-connected' });
  if (err instanceof LibraryAccessError) return reply.code(400).send({ error: err.message, code: 'access' });
  return reply.code(502).send({ error: err instanceof Error ? err.message : 'The reference manager did not answer' });
}

/** Link list changes, one at a time per project (read, change, write). */
const linkLocks = new Map<string, Promise<unknown>>();
function withLinks<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = linkLocks.get(projectId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  linkLocks.set(projectId, tail);
  void tail.then(() => { if (linkLocks.get(projectId) === tail) linkLocks.delete(projectId); });
  return run;
}

// ---- OAuth state: random, bound to the browser by a cookie signed under its own subkey ----

const STATE_COOKIE = 'laytekz_library_oauth';
interface Pending { provider: 'zotero' | 'mendeley'; account: string; back: string; exp: number; token?: string; secret?: string }
const pending = new Map<string, Pending>();
const sign = (state: string) => crypto.createHmac('sha256', subkey('library-oauth')).update(state).digest('base64url').slice(0, 32);
/** Where a callback may send the person back: their project, its settings, or the settings page. */
const RETURN_RE = /^\/(?:p\/[A-Za-z0-9_-]{1,64}(?:\/settings(?:\/[a-z-]{1,40})?)?|settings(?:\/[a-z-]{1,40})?)?$/;

function backTo(reply: FastifyReply, p: { provider: string; back: string }, outcome: 'connected' | 'denied' | 'failed' | 'state') {
  reply.header('set-cookie', `${STATE_COOKIE}=; Path=${auth.COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${auth.SECURE_COOKIES ? '; Secure' : ''}`);
  const q = outcome === 'connected' ? `library=${p.provider}&connected=1` : `library=${p.provider}&error=${outcome}`;
  return reply.redirect(`${config.basePath}${p.back || '/'}?${q}`);
}

/** The pending sign-in this callback belongs to, or null (wrong browser, expired, someone else's). */
function takePending(req: Req, me: string | null, provider: string, state: unknown): Pending | null {
  if (typeof state !== 'string' || state.length > 64) return null;
  const cookie = auth.parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
  const [cs, sig] = cookie.split('.');
  if (!cs || cs !== state || !sig || sig.length !== 32 || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(cs)))) return null;
  const p = pending.get(state);
  pending.delete(state);
  if (!p || p.provider !== provider || p.exp < Date.now()) return null;
  return me === p.account ? p : null;
}

function startPending(reply: FastifyReply, p: Pending, state = crypto.randomBytes(16).toString('hex')): string {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  pending.set(state, p);
  reply.header('set-cookie', `${STATE_COOKIE}=${state}.${sign(state)}; HttpOnly; SameSite=Lax; Path=${auth.COOKIE_PATH}; Max-Age=600${auth.SECURE_COOKIES ? '; Secure' : ''}`);
  return state;
}

// ---- the rows GET /api/projects/:id/libraries answers ----

async function row(meta: ProjectMeta, l: LibraryLink, me: auth.PublicUser | null) {
  const status = linkStatus(meta, l);
  const paused = (await pausedReason(meta, l)) ?? status.storedPause;
  const mine = !auth.AUTH_ENABLED || (!!me && me.id === l.linkedBy);
  return {
    id: l.id, provider: l.provider, linkedBy: l.linkedBy, linkedByName: (await accountName(l.linkedBy)) ?? 'Someone',
    mine, canChange: mine || isOwner(meta, me),
    library: l.library, libraryName: l.libraryName ?? null, collection: l.collection ?? null, collectionName: l.collectionName ?? null,
    bibFile: l.bibFile, recursive: l.recursive, omitFields: l.omitFields, lastSyncedAt: status.lastSyncedAt,
    ...(paused ? { pausedReason: paused } : {}), ...(l.legacy ? { legacy: true } : {}),
  };
}

/** A file name nobody uses: `zotero.bib`, then `zotero-<first name>.bib`, beside the root file. */
async function defaultBibFile(meta: ProjectMeta, branch: string, provider: ProviderId, accountId: string, taken: Set<string>): Promise<string> {
  const base = provider === 'desktop-file' ? 'library' : provider;
  const free = (p: string) => !taken.has(p) && !store.fileExists(meta.id, branch, p);
  const first = rootSiblingPath(meta.rootFile, `${base}.bib`);
  if (free(first)) return first;
  const name = asciiFold(((await accountName(accountId)) ?? '').split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'mine';
  for (let i = 1; i < 50; i++) {
    const p = rootSiblingPath(meta.rootFile, `${base}-${name}${i > 1 ? i : ''}.bib`);
    if (free(p)) return p;
  }
  return rootSiblingPath(meta.rootFile, `${base}-${crypto.randomBytes(3).toString('hex')}.bib`);
}

const feature: ServerFeature = {
  id: 'libraries',
  projectSettings: [
    // The links: server only (credentials never live here; the linker's account holds them).
    { id: LINKS_KEY, validate: validLinks, clientWritable: false, clientVisible: false, copyWithProject: false },
  ],
  capabilities() {
    const cfg = librariesConfig();
    return { libraries: { zotero: { key: true, oauth: !!cfg.zoteroOAuth }, mendeley: !!cfg.mendeley, desktopFile: true, maxLinks: cfg.maxLinks } };
  },
  register(app, kit: RouteKit) {
    /** The account a connection belongs to; replies 401 and resolves null when signed out (accounts on). */
    const account = (req: Req, reply: FastifyReply): string | null => {
      const u = kit.user(req);
      if (auth.AUTH_ENABLED && !u) { reply.code(401).send({ error: 'Sign in required' }); return null; }
      return u?.id || 'local';
    };
    const me = (req: Req): string | null => (auth.AUTH_ENABLED ? kit.user(req)?.id ?? null : 'local');
    const limited = kit.limiter('upstream', { burst: 30, perSecond: 1 });
    const slow = (req: Req, reply: FastifyReply) => {
      if (limited(req)) return false;
      reply.code(429).send({ error: 'Too many library requests. Wait a moment and try again.' });
      return true;
    };
    const writeLinks = async (projectId: string, links: LibraryLink[]) => {
      const clean = links.filter((l) => !l.legacy).map(({ legacy: _l, ...l }) => l);
      await kit.writeExt(projectId, clean.length ? { [LINKS_KEY]: clean } : {}, clean.length ? [] : [LINKS_KEY]);
    };
    const tell = (projectId: string, branch: string | '*' = '*') => {
      try { kit.signal(projectId, branch, LIBRARIES_SIGNAL, `${Date.now()}.${crypto.randomBytes(3).toString('hex')}`); } catch { /* no open branch */ }
    };
    const branchOf = async (reply: FastifyReply, projectId: string, raw: unknown): Promise<string | null> => {
      const branch = typeof raw === 'string' && raw ? raw : 'main';
      if (!BRANCH_RE.test(branch)) { reply.code(400).send({ error: 'invalid branch name' }); return null; }
      try { await ensureWorktree(projectId, branch); } catch { reply.code(404).send({ error: 'Branch not found' }); return null; }
      return branch;
    };
    const findLink = (meta: ProjectMeta, linkId: unknown) => (typeof linkId === 'string' && LINK_ID_RE.test(linkId) ? projectLinks(meta).find((l) => l.id === linkId) ?? null : null);
    const mayChange = (meta: ProjectMeta, l: LibraryLink, req: Req) => {
      const me = kit.user(req);
      return !auth.AUTH_ENABLED || (!!me && (me.id === l.linkedBy || isOwner(meta, me)));
    };
    const syncJob = (meta: ProjectMeta, branch: string, link: LibraryLink, req: Req, o: { force?: boolean; olderThan?: number; first?: boolean }) =>
      startSyncJob(meta.id, branch, link.id, () => syncLink(meta.id, branch, link, { force: o.force, olderThan: o.olderThan, by: editorOf(kit.user(req)) }),
        o.first ? async () => {
          // A library that cannot be exported never becomes the project's link (V1's rule).
          await withLinks(meta.id, async () => {
            const fresh = await store.readMeta(meta.id);
            if (readState(meta.id, link.id).lastSyncedAt) return;
            await writeLinks(meta.id, storedLinks(fresh).filter((l) => l.id !== link.id));
            dropState(meta.id, link.id);
          });
          tell(meta.id);
        } : undefined);

    // ---------- account connections ----------

    app.get<{ Params: { provider: string } }>('/api/libraries/:provider/connection', async (req, reply) => {
      const p = accountProvider(req.params.provider);
      if (!p) return reply.code(404).send({ error: 'Unknown reference manager' });
      const acct = account(req, reply);
      if (!acct) return;
      const cfg = librariesConfig();
      const c = p.enabled() ? await p.connection(acct) : { connected: false };
      reply.header('cache-control', 'no-store');
      return { provider: p.id, enabled: p.enabled(), connected: c.connected, name: c.name ?? null, oauth: p.id === 'zotero' ? !!cfg.zoteroOAuth : p.enabled(), keyPaste: p.id === 'zotero' };
    });

    app.put<{ Params: { provider: string }; Body: { apiKey?: unknown } }>('/api/libraries/:provider/connection', async (req, reply) => {
      const acct = account(req, reply);
      if (!acct) return;
      if (req.params.provider === 'mendeley') return reply.code(400).send({ error: 'Mendeley connects by signing in: use "Sign in with Mendeley".' });
      if (req.params.provider !== 'zotero') return reply.code(404).send({ error: 'Unknown reference manager' });
      if (slow(req, reply)) return;
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (!apiKey || apiKey.length > 200) return reply.code(400).send({ error: 'Paste a Zotero API key first' });
      try {
        const info = await zotero.validateKey(apiKey);
        await zotero.saveKey(acct, { apiKey, userID: info.userID, username: info.username });
        return { provider: 'zotero', enabled: true, connected: true, name: info.username ?? null, oauth: !!librariesConfig().zoteroOAuth, keyPaste: true };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : 'Zotero rejected the key' });
      }
    });

    app.delete<{ Params: { provider: string } }>('/api/libraries/:provider/connection', async (req, reply) => {
      const p = accountProvider(req.params.provider);
      if (!p) return reply.code(404).send({ error: 'Unknown reference manager' });
      const acct = account(req, reply);
      if (!acct) return;
      await p.forget(acct);
      return { ok: true };
    });

    app.get<{ Params: { provider: string } }>('/api/libraries/:provider/libraries', async (req, reply) => {
      const p = accountProvider(req.params.provider);
      if (!p || !p.enabled()) return reply.code(404).send({ error: 'Unknown reference manager' });
      const acct = account(req, reply);
      if (!acct || slow(req, reply)) return;
      try { return { libraries: await p.listLibraries(acct) }; } catch (err) { return upstream(reply, err); }
    });

    app.get<{ Params: { provider: string }; Querystring: { library?: string } }>('/api/libraries/:provider/collections', async (req, reply) => {
      const p = accountProvider(req.params.provider);
      if (!p || !p.enabled()) return reply.code(404).send({ error: 'Unknown reference manager' });
      const acct = account(req, reply);
      if (!acct) return;
      if (!validLibrary(p.id, req.query.library)) return reply.code(400).send({ error: 'Choose a library' });
      if (slow(req, reply)) return;
      try { return { collections: await p.listCollections(acct, req.query.library) }; } catch (err) { return upstream(reply, err); }
    });

    app.get<{ Params: { provider: string }; Querystring: { library?: string; q?: string; format?: string } }>('/api/libraries/:provider/search', async (req, reply) => {
      const p = accountProvider(req.params.provider);
      if (!p || !p.enabled()) return reply.code(404).send({ error: 'Unknown reference manager' });
      const acct = account(req, reply);
      if (!acct) return;
      const library = p.id === 'mendeley' && !req.query.library ? 'me' : req.query.library;
      if (!validLibrary(p.id, library)) return reply.code(400).send({ error: 'Choose a library' });
      const q = (req.query.q || '').trim().slice(0, 200);
      if (!q) return { results: [] };
      if (slow(req, reply)) return;
      try { return { results: await p.search(acct, library, q, req.query.format === 'bibtex' ? 'bibtex' : 'biblatex') }; } catch (err) { return upstream(reply, err); }
    });

    // ---------- OAuth ----------

    app.get<{ Params: { provider: string }; Querystring: { return?: string } }>('/api/libraries/:provider/connect', async (req, reply) => {
      const cfg = librariesConfig();
      const provider = req.params.provider;
      if (!((provider === 'mendeley' && cfg.mendeley) || (provider === 'zotero' && cfg.zoteroOAuth))) return reply.code(404).send({ error: 'Signing in to this reference manager is not set up on this server' });
      const acct = account(req, reply);
      if (!acct) return;
      const back = typeof req.query.return === 'string' && RETURN_RE.test(req.query.return) ? req.query.return : '/';
      if (provider === 'mendeley') {
        const state = startPending(reply, { provider, account: acct, back, exp: Date.now() + 600_000 });
        return reply.redirect(mendeleyAuthorizeUrl(state, `${publicBase(req)}/api/libraries/mendeley/callback`));
      }
      try {
        // OAuth 1.0a carries no state: it rides in the callback URL.
        const state = crypto.randomBytes(16).toString('hex');
        const started = await zoteroOAuthStart(`${publicBase(req)}/api/libraries/zotero/oauth/callback?state=${state}`);
        startPending(reply, { provider: 'zotero', account: acct, back, exp: Date.now() + 600_000, token: started.token, secret: started.secret }, state);
        return reply.redirect(started.authorizeUrl);
      } catch (err) {
        return reply.code(502).send({ error: err instanceof Error ? err.message : 'Zotero did not answer' });
      }
    });

    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/libraries/mendeley/callback', async (req, reply) => {
      if (!librariesConfig().mendeley) return reply.code(404).send({ error: 'Mendeley is not set up on this server' });
      const p = takePending(req, me(req), 'mendeley', req.query.state);
      if (!p) return backTo(reply, { provider: 'mendeley', back: '/' }, 'state');
      if (req.query.error || !req.query.code) return backTo(reply, p, 'denied');
      try {
        await mendeleyConnect(p.account, req.query.code, `${publicBase(req)}/api/libraries/mendeley/callback`);
        return backTo(reply, p, 'connected');
      } catch (err) {
        req.log.warn({ err: (err as Error)?.message }, 'Mendeley connect failed');
        return backTo(reply, p, 'failed');
      }
    });

    app.get<{ Querystring: { state?: string; oauth_token?: string; oauth_verifier?: string } }>('/api/libraries/zotero/oauth/callback', async (req, reply) => {
      if (!librariesConfig().zoteroOAuth) return reply.code(404).send({ error: 'Sign in with Zotero is not set up on this server' });
      const p = takePending(req, me(req), 'zotero', req.query.state);
      if (!p) return backTo(reply, { provider: 'zotero', back: '/' }, 'state');
      if (!req.query.oauth_verifier || req.query.oauth_token !== p.token) return backTo(reply, p, 'denied');
      try {
        const key = await zoteroOAuthFinish(p.token!, p.secret!, req.query.oauth_verifier);
        await zotero.saveKey(p.account, key);
        return backTo(reply, p, 'connected');
      } catch (err) {
        req.log.warn({ err: (err as Error)?.message }, 'Zotero sign-in failed');
        return backTo(reply, p, 'failed');
      }
    });

    // ---------- project links ----------

    app.get<{ Params: { id: string } }>('/api/projects/:id/libraries', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      reply.header('cache-control', 'no-store');
      const me = kit.user(req);
      return Promise.all(projectLinks(meta).map((l) => row(meta, l, me)));
    });

    app.post<{ Params: { id: string }; Body: { provider?: unknown; library?: unknown; collection?: unknown; recursive?: unknown; bibFile?: unknown; omitFields?: unknown; branch?: unknown; replace?: unknown } }>(
      '/api/projects/:id/libraries', async (req, reply) => {
        const meta0 = await kit.requireMember(req, reply, 'link a library');
        if (!meta0) return;
        const b = req.body ?? {};
        const provider = b.provider as ProviderId;
        if (!(PROVIDER_IDS as readonly unknown[]).includes(provider)) return reply.code(400).send({ error: 'Choose Zotero, Mendeley or a file on your computer' });
        const p = providerFor(provider);
        if (p && !p.enabled()) return reply.code(404).send({ error: `${PROVIDER_LABEL[provider]} is not set up on this server` });
        const library = provider === 'desktop-file' ? '' : b.library;
        if (!validLibrary(provider, library)) return reply.code(400).send({ error: 'Choose a library' });
        if (!validCollection(provider, b.collection)) return reply.code(400).send({ error: 'Choose a collection' });
        if (b.omitFields !== undefined && !validOmit(b.omitFields)) return reply.code(400).send({ error: 'Unknown field group to leave out' });
        const branch = await branchOf(reply, meta0.id, b.branch);
        if (!branch) return;
        const me = kit.user(req);
        const acct = me?.id || 'local';
        if (p && !(await p.connection(acct)).connected) return reply.code(400).send({ error: `Connect ${PROVIDER_LABEL[provider]} first`, code: 'not-connected' });
        const collection = typeof b.collection === 'string' && b.collection ? b.collection : undefined;
        const names = p ? await p.names(acct, library as string, collection).catch(() => ({})) : {};
        const out = await withLinks(meta0.id, async () => {
          const meta = await store.readMeta(meta0.id);
          const all = projectLinks(meta);
          if (all.length >= librariesConfig().maxLinks) return { status: 409, body: { error: `A project can have at most ${librariesConfig().maxLinks} linked libraries. Unlink one first.` } };
          const taken = new Set(all.map((l) => l.bibFile));
          let bibFile: string;
          if (b.bibFile !== undefined && b.bibFile !== '') {
            const clean = cleanBibPath(b.bibFile);
            if (!clean) return { status: 400, body: { error: 'The file must be a .bib inside the project' } };
            if (taken.has(clean)) return { status: 409, body: { error: 'Another linked library already writes that file. Choose another name.', code: 'taken' } };
            if (store.fileExists(meta.id, branch, clean) && b.replace !== true) return { status: 409, body: { error: 'That file already exists, and each sync would replace it. Choose another name.', code: 'exists' } };
            bibFile = clean;
          } else {
            bibFile = await defaultBibFile(meta, branch, provider, acct, taken);
          }
          let id = '';
          do id = `l${crypto.randomBytes(6).toString('hex')}`; while (all.some((l) => l.id === id));
          const link: LibraryLink = {
            id, provider, linkedBy: acct, library: library as string, ...(collection ? { collection } : {}),
            recursive: b.recursive === undefined ? true : b.recursive === true,
            ...(names as object), bibFile,
            omitFields: (b.omitFields as OmitGroup[] | undefined) ?? (provider === 'desktop-file' ? [] : [...DEFAULT_OMIT]),
            createdAt: new Date().toISOString(),
          };
          await writeLinks(meta.id, [...storedLinks(meta), link]);
          return { status: 200, link, meta: await store.readMeta(meta.id) };
        });
        if (out.status !== 200 || !('link' in out)) return reply.code(out.status).send(out.body);
        tell(meta0.id);
        const job = provider === 'desktop-file' ? null : syncJob(out.meta!, branch, out.link!, req, { force: true, first: true });
        return { link: await row(out.meta!, out.link!, me), ...(job ? { jobId: job.id } : {}) };
      });

    app.patch<{ Params: { id: string; linkId: string }; Body: { library?: unknown; collection?: unknown; recursive?: unknown; omitFields?: unknown; bibFile?: unknown; branch?: unknown; replace?: unknown } }>(
      '/api/projects/:id/libraries/:linkId', async (req, reply) => {
        const meta0 = await kit.requireMember(req, reply, 'change a linked library');
        if (!meta0) return;
        const link0 = findLink(meta0, req.params.linkId);
        if (!link0) return reply.code(404).send({ error: 'No such linked library' });
        if (!mayChange(meta0, link0, req)) return reply.code(403).send({ error: 'Only the person who linked this library, or the project owner, can change it' });
        const b = req.body ?? {};
        const branch = await branchOf(reply, meta0.id, b.branch);
        if (!branch) return;
        const me = kit.user(req);
        const acct = me?.id || 'local';
        if (link0.legacy && !(await zoteroProvider.connection(acct)).connected) {
          return reply.code(409).send({ error: 'Connect your Zotero account in Settings first, then change this link.', code: 'not-connected' });
        }
        const library = b.library === undefined ? link0.library : b.library;
        if (!validLibrary(link0.provider, library)) return reply.code(400).send({ error: 'Choose a library' });
        if (!validCollection(link0.provider, b.collection)) return reply.code(400).send({ error: 'Choose a collection' });
        if (b.omitFields !== undefined && !validOmit(b.omitFields)) return reply.code(400).send({ error: 'Unknown field group to leave out' });
        if (b.recursive !== undefined && typeof b.recursive !== 'boolean') return reply.code(400).send({ error: '"recursive" is true or false' });
        const collection = b.collection === undefined ? link0.collection : (typeof b.collection === 'string' && b.collection ? b.collection : undefined);
        const p = providerFor(link0.provider);
        const linker = link0.legacy ? acct : link0.linkedBy;
        const names = p && (library !== link0.library || collection !== link0.collection) ? await p.names(linker, library as string, collection).catch(() => ({})) : null;
        const out = await withLinks(meta0.id, async () => {
          const meta = await store.readMeta(meta0.id);
          const current = projectLinks(meta).find((l) => l.id === link0.id);
          if (!current) return { status: 404, body: { error: 'No such linked library' } };
          let bibFile = current.bibFile;
          if (b.bibFile !== undefined && b.bibFile !== current.bibFile) {
            const clean = cleanBibPath(b.bibFile);
            if (!clean) return { status: 400, body: { error: 'The file must be a .bib inside the project' } };
            if (projectLinks(meta).some((l) => l.id !== current.id && l.bibFile === clean)) return { status: 409, body: { error: 'Another linked library already writes that file. Choose another name.', code: 'taken' } };
            if (store.fileExists(meta.id, branch, clean) && b.replace !== true) return { status: 409, body: { error: 'That file already exists, and each sync would replace it. Choose another name.', code: 'exists' } };
            bibFile = clean;
          }
          let id = current.id;
          if (current.legacy) do id = `l${crypto.randomBytes(6).toString('hex')}`; while (projectLinks(meta).some((l) => l.id === id));
          const { legacy: _legacy, ...base } = current;
          const next: LibraryLink = {
            ...base, id, linkedBy: current.legacy ? acct : current.linkedBy, library: library as string, bibFile,
            recursive: b.recursive === undefined ? current.recursive : (b.recursive as boolean),
            omitFields: (b.omitFields as OmitGroup[] | undefined) ?? (current.legacy ? [...DEFAULT_OMIT] : current.omitFields),
            ...(names ?? {}),
          };
          if (collection) next.collection = collection; else { delete next.collection; delete next.collectionName; }
          await writeLinks(meta.id, current.legacy ? [...storedLinks(meta), next] : storedLinks(meta).map((l) => (l.id === current.id ? next : l)));
          if (current.legacy) {
            // V1's link (and the key it carried) gives way to the account's own connection.
            const again = await store.readMeta(meta.id);
            if (again.zotero) { writeState(meta.id, id, { lastSyncedAt: again.zotero.lastSyncedAt, format: again.zotero.format }); delete again.zotero; await store.writeMeta(again); }
          } else if (next.library !== current.library || next.collection !== current.collection || next.recursive !== current.recursive) {
            const s = readState(meta.id, id);
            writeState(meta.id, id, { ...s, version: undefined });
          }
          return { status: 200, link: next, changed: JSON.stringify({ ...current, legacy: undefined }) !== JSON.stringify(next) || !!current.legacy, meta: await store.readMeta(meta.id) };
        });
        if (out.status !== 200 || !('link' in out)) return reply.code(out.status).send(out.body);
        tell(meta0.id);
        const job = out.changed && out.link!.provider !== 'desktop-file' ? syncJob(out.meta!, branch, out.link!, req, { force: true }) : null;
        return { link: await row(out.meta!, out.link!, me), ...(job ? { jobId: job.id } : {}) };
      });

    app.delete<{ Params: { id: string; linkId: string } }>('/api/projects/:id/libraries/:linkId', async (req, reply) => {
      const meta0 = await kit.requireMember(req, reply, 'unlink a library');
      if (!meta0) return;
      const link = findLink(meta0, req.params.linkId);
      if (!link) return reply.code(404).send({ error: 'No such linked library' });
      if (!mayChange(meta0, link, req)) return reply.code(403).send({ error: 'Only the person who linked this library, or the project owner, can unlink it' });
      await withLinks(meta0.id, async () => {
        const meta = await store.readMeta(meta0.id);
        if (link.legacy) { delete meta.zotero; await store.writeMeta(meta); return; }
        await writeLinks(meta.id, storedLinks(meta).filter((l) => l.id !== link.id));
        dropState(meta.id, link.id);
      });
      tell(meta0.id);
      return { ok: true };
    });

    app.post<{ Params: { id: string; linkId: string }; Body: { branch?: unknown; force?: unknown; olderThan?: unknown } }>('/api/projects/:id/libraries/:linkId/sync', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'sync a linked library');
      if (!meta) return;
      const link = findLink(meta, req.params.linkId);
      if (!link) return reply.code(404).send({ error: 'No such linked library' });
      if (link.provider === 'desktop-file') return reply.code(400).send({ error: 'This file syncs from the desktop app on the computer that has it', code: 'desktop' });
      const paused = await pausedReason(meta, link);
      if (paused) return reply.code(409).send({ error: paused, code: 'paused' });
      const branch = await branchOf(reply, meta.id, req.body?.branch);
      if (!branch) return;
      const olderThan = typeof req.body?.olderThan === 'number' && req.body.olderThan > 0 ? req.body.olderThan : undefined;
      const job = syncJob(meta, branch, link, req, { force: req.body?.force === true, olderThan });
      return { jobId: job.id };
    });

    app.get<{ Params: { id: string; jobId: string } }>('/api/projects/:id/libraries/jobs/:jobId', async (req, reply) => {
      const meta = await kit.requireAccess(req, reply);
      if (!meta) return;
      const job = getJob(req.params.jobId);
      if (!job || job.projectId !== meta.id) return reply.code(404).send({ error: 'No such sync' });
      reply.header('cache-control', 'no-store');
      const { renamedKeys, ...result } = job.result ?? ({} as Record<string, never>);
      return {
        state: job.state, linkId: job.linkId, branch: job.branch,
        ...(job.result ? { result } : {}), ...(renamedKeys?.length ? { renamedKeys } : {}),
        ...(job.error ? { error: job.error, code: job.code } : {}),
      };
    });

    app.put<{ Params: { id: string; linkId: string }; Body: { content?: unknown; branch?: unknown } }>(
      '/api/projects/:id/libraries/:linkId/content', { bodyLimit: 32 * 1024 * 1024 }, async (req, reply) => {
        const meta = await kit.requireMember(req, reply, 'update a linked file');
        if (!meta) return;
        const link = findLink(meta, req.params.linkId);
        if (!link) return reply.code(404).send({ error: 'No such linked library' });
        if (link.provider !== 'desktop-file') return reply.code(400).send({ error: 'Only a file linked from the desktop app takes pushed content' });
        const me = kit.user(req);
        if (auth.AUTH_ENABLED && me?.id !== link.linkedBy) return reply.code(403).send({ error: 'Only the person who linked this file can update it' });
        const content = req.body?.content;
        if (typeof content !== 'string') return reply.code(400).send({ error: 'Send {"content": "<the .bib text>"}' });
        if (Buffer.byteLength(content) > librariesConfig().contentMaxBytes) return reply.code(413).send({ error: 'The file is larger than 20 MB' });
        const paused = await pausedReason(meta, link);
        if (paused) return reply.code(409).send({ error: paused, code: 'paused' });
        const branch = await branchOf(reply, meta.id, req.body?.branch);
        if (!branch) return;
        const r = await pushContent(meta.id, branch, link, content, editorOf(me));
        tell(meta.id, branch);
        return { ok: true, ...r };
      });

    app.post<{ Params: { id: string }; Body: { branch?: unknown; renames?: unknown } }>('/api/projects/:id/libraries/update-citations', async (req, reply) => {
      const meta = await kit.requireMember(req, reply, 'update citations');
      if (!meta) return;
      const raw = req.body?.renames;
      if (!Array.isArray(raw) || !raw.length || raw.length > 500) return reply.code(400).send({ error: 'Send {"renames": [{"from": "old", "to": "new"}]}' });
      const renames: Array<{ from: string; to: string }> = [];
      for (const r of raw) {
        const from = (r as { from?: unknown })?.from;
        const to = (r as { to?: unknown })?.to;
        if (typeof from !== 'string' || typeof to !== 'string' || !validKey(from) || !validKey(to) || from === to) return reply.code(400).send({ error: 'Each rename needs two different citation keys' });
        renames.push({ from, to });
      }
      const branch = await branchOf(reply, meta.id, req.body?.branch);
      if (!branch) return;
      const out = await updateCitations(meta.id, branch, renames, editorOf(kit.user(req)), kit.author(req));
      return { ok: true, ...out };
    });
  },
};

export default feature;
