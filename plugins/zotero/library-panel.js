/**
 * Galley: V2 (WP36) a reference manager's panel over the generic library links
 * (WP35's routes): sign in, link a library or folder to a .bib of your own,
 * sync it, unlink it, and cite from it. The Mendeley tab uses it; any member
 * who can edit links their own library, up to five links per project.
 *
 * Routes (WP35): GET|DELETE /api/libraries/:p/connection, GET /api/libraries/:p/connect
 * (OAuth start, a top-level navigation), GET /api/libraries/:p/{libraries,collections},
 * GET|POST /api/projects/:id/libraries, DELETE /api/projects/:id/libraries/:linkId,
 * POST …/:linkId/sync → {jobId}, GET …/libraries/jobs/:jobId → {state, renamedKeys?, error?}.
 */

const MAX_LINKS = 5;

/** The fields a link can leave out of the .bib; everyone in the project can read it. */
const OMIT_FIELDS = [
  { id: 'abstract', label: 'Abstracts', on: true },
  { id: 'file', label: 'Files and annotations', on: true },
  { id: 'keywords', label: 'Tags (keywords)', on: true },
  { id: 'note', label: 'Extra (note)', on: false },
];

/** The site root the plugin was served under (`<base>/plugins/zotero/…`), for navigations. */
const BASE = (() => {
  try { return new URL('../../', import.meta.url).pathname.replace(/\/$/, ''); } catch { return ''; }
})();

const asList = (raw, ...keys) => {
  if (Array.isArray(raw)) return raw;
  for (const k of keys) if (raw && Array.isArray(raw[k])) return raw[k];
  return [];
};

const jobState = (s) => {
  if (typeof s !== 'string') return null;
  if (/^(done|ok|finished|complete|completed|succeeded|success|synced|unchanged)$/i.test(s)) return 'done';
  if (/^(error|failed|failure|cancelled|canceled|paused)$/i.test(s)) return 'failed';
  return null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');

/** `<p>.bib` next to the root file, numbered when a file or link has it. */
function defaultBibFile(provider, taken, rootFile) {
  const dir = rootFile && rootFile.includes('/') ? rootFile.slice(0, rootFile.lastIndexOf('/') + 1) : '';
  const used = new Set([...taken].map(normPath));
  if (!used.has(`${dir}${provider}.bib`)) return `${dir}${provider}.bib`;
  for (let i = 2; ; i++) if (!used.has(`${dir}${provider}-${i}.bib`)) return `${dir}${provider}-${i}.bib`;
}

const validBibFile = (p) => {
  const n = normPath(String(p).trim());
  return /\.bib$/i.test(n) && !n.split('/').some((s) => s === '..' || s === '');
};

/** Collections as `{id, path}` sorted by path: parents' names first, so two "Drafts" tell apart. */
function collectionPaths(list) {
  const rows = list.map((c) => ({
    id: String(c.id ?? c.key ?? ''),
    name: String(c.name ?? c.data?.name ?? ''),
    parent: c.parentId ?? c.parent ?? c.parentCollection ?? c.data?.parentCollection ?? null,
    path: typeof c.path === 'string' ? c.path : null,
  })).filter((c) => c.id);
  const byId = new Map(rows.map((c) => [c.id, c]));
  const pathOf = (c, depth = 0) => {
    if (c.path) return c.path;
    const parent = c.parent ? byId.get(String(c.parent)) : null;
    return parent && depth < 20 ? `${pathOf(parent, depth + 1)} › ${c.name}` : c.name;
  };
  return rows.map((c) => ({ id: c.id, path: pathOf(c) })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * @param aldine the plugin API
 * @param cfg { provider, label, capability, allItems, folderWord, help }
 * @param util { h, announce, syncOnOpen, citeToast, staleSeconds }
 */
export function registerLibraryPanel(aldine, cfg, util) {
  const { h, announce, syncOnOpen, citeToast, staleSeconds } = util;
  const p = cfg.provider;
  const tid = (s) => `${p}-${s}`;
  let panel = null;

  aldine.ui.registerCommand?.({
    id: `${p}-open`, group: 'References', title: `${cfg.label}: link or cite from your library`, keywords: `${p} bibliography references import cite library`,
    run: () => aldine.ui.showPanel(p),
  });
  aldine.ui.registerCommand?.({
    id: `${p}-sync`, group: 'References', title: `${cfg.label}: sync linked libraries now`, keywords: `${p} bibliography references refresh update`,
    run: () => { aldine.ui.showPanel(p); panel?.syncAll(); },
  });

  aldine.ui.registerSidebarPanel({
    id: p,
    title: cfg.label,
    render(root) {
      const pid = aldine.project.id;
      const projectUrl = `/api/projects/${encodeURIComponent(pid)}/libraries`;
      const state = {
        view: 'loading', // loading | unsupported | main | pick
        configured: false,
        connection: null, // { connected, name }
        links: [],
        allLinks: [],
        canEdit: true,
        rootFile: null,
        files: [],
        // pick
        libraries: [],
        library: '',
        collections: [],
        collection: '',
        recursive: true,
        bibFile: '',
        omit: new Set(OMIT_FIELDS.filter((f) => f.on).map((f) => f.id)),
        // per link: 'syncing' | 'unlinking'
        busy: new Map(),
        linking: false,
        searching: '',
        bibEntries: [],
        bibLoaded: false,
      };

      const jfetch = async (url, init) => {
        const res = await aldine.fetch(url, init?.body ? { headers: { 'content-type': 'application/json' }, ...init } : init);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { const err = new Error(body.error || `HTTP ${res.status}`); err.status = res.status; throw err; }
        return body;
      };

      const rerender = () => {
        const active = document.activeElement;
        const testid = root.contains(active) ? active.dataset.testid : null;
        const caret = testid && typeof active.selectionStart === 'number' ? active.selectionStart : null;
        root.replaceChildren(build());
        const next = testid && root.querySelector(`[data-testid="${testid}"]`);
        if (!next) return;
        next.focus();
        if (caret != null && typeof next.setSelectionRange === 'function') next.setSelectionRange(caret, caret);
      };

      const loadLinks = async () => {
        const all = asList(await jfetch(projectUrl), 'links', 'libraries');
        state.allLinks = all;
        state.links = all.filter((l) => l && l.provider === p && l.id && l.bibFile);
      };

      let firstLoad = true;
      const load = async () => {
        try {
          const caps = await jfetch('/api/capabilities').catch(() => ({}));
          state.configured = caps[`libraries.${cfg.capability}`] === true || caps.libraries?.[cfg.capability] === true;
          const res = await aldine.fetch(`/api/libraries/${p}/connection`);
          if (res.status === 404) { state.view = 'unsupported'; rerender(); return; }
          const conn = await res.json().catch(() => ({}));
          state.connection = res.ok ? { connected: conn.connected === true, name: conn.name || conn.username || '' } : { connected: false, name: '' };
          const project = await jfetch(`/api/projects/${encodeURIComponent(pid)}`).catch(() => ({}));
          state.canEdit = (aldine.project.canEdit?.() ?? true) && project.canEdit !== false && !project.readOnly && project.isMember !== false;
          state.rootFile = project.rootFile || null;
          await loadLinks();
          state.view = state.view === 'pick' ? 'pick' : 'main';
        } catch (err) {
          if (err.status === 404) state.view = 'unsupported';
          else { state.view = 'main'; state.loadError = err.message; }
        }
        rerender();
        if (firstLoad) { firstLoad = false; syncStale(); }
      };

      // ---- sync ----
      const waitForJob = async (jobId) => {
        const started = Date.now();
        let delay = 600;
        while (Date.now() - started < 15 * 60_000) {
          await sleep(delay);
          delay = Math.min(delay * 1.5, 4000);
          let job;
          try {
            job = await jfetch(`${projectUrl}/jobs/${encodeURIComponent(jobId)}`);
          } catch (err) {
            if (err.status === 404) throw err;
            continue;
          }
          const s = jobState(job.state);
          if (s === 'done') return job;
          if (s === 'failed') throw new Error(job.error || 'the sync failed');
        }
        throw new Error('it is taking long and goes on in the background');
      };

      /** POST …/sync, then the job. Returns the job's result, or null when the link was fresh. */
      const runSync = async (link, olderThan) => {
        const res = await jfetch(`${projectUrl}/${encodeURIComponent(link.id)}/sync`, {
          method: 'POST',
          body: JSON.stringify({ branch: aldine.project.branch, ...(olderThan ? { olderThan } : {}) }),
        });
        if (!res.jobId) return res.fresh ? null : res;
        return waitForJob(res.jobId);
      };

      const afterSync = async (link, job) => {
        if (job && job.renamedKeys) {
          announce({ type: 'renamed', projectId: pid, branch: aldine.project.branch, provider: p, linkId: link.id, renames: job.renamedKeys });
        }
        announce({ type: 'changed', projectId: pid, provider: p, linkId: link.id });
        await aldine.project.refreshFiles();
        await loadLinks().catch(() => {});
        state.bibLoaded = false;
      };

      const syncLink = async (link, { quiet = false, olderThan = 0 } = {}) => {
        if (state.busy.has(link.id)) return;
        state.busy.set(link.id, 'syncing');
        rerender();
        try {
          const job = await runSync(link, olderThan);
          if (job) {
            const n = job.itemCount ?? job.items;
            const msg = job.unchanged || job.state === 'unchanged'
              ? `${cfg.label} library unchanged`
              : `Synced ${n != null ? `${n} ` : ''}references from ${cfg.label} into ${link.bibFile}`;
            aldine.toast(msg, quiet ? 'info' : 'ok');
            await afterSync(link, job);
          }
        } catch (err) {
          if (!quiet) aldine.toast(`${cfg.label} sync failed: ${err.message}`, 'error');
        }
        state.busy.delete(link.id);
        rerender();
      };

      // Once per page load, when the setting is on: links whose last sync is over an hour old.
      const syncStale = () => {
        if (!state.canEdit || !syncOnOpen(aldine)) return;
        const now = Date.now();
        for (const link of state.links) {
          if (link.pausedReason) continue;
          const last = link.lastSyncedAt ? Date.parse(link.lastSyncedAt) : 0;
          if (now - last > staleSeconds * 1000) syncLink(link, { quiet: true, olderThan: staleSeconds });
        }
      };

      const unlink = async (link) => {
        const ok = await aldine.ui.confirm({ title: `Unlink ${cfg.label} from this project?`, body: `${link.bibFile} stays in the project and becomes an ordinary file you can edit.`, confirmLabel: 'Unlink', danger: true });
        if (!ok) return;
        state.busy.set(link.id, 'unlinking');
        rerender();
        try {
          await jfetch(`${projectUrl}/${encodeURIComponent(link.id)}`, { method: 'DELETE' });
          aldine.toast(`Unlinked ${link.bibFile}`, 'ok');
          announce({ type: 'changed', projectId: pid, provider: p, linkId: link.id });
          await loadLinks();
        } catch (err) {
          aldine.toast(`Unlink failed: ${err.message}`, 'error');
        }
        state.busy.delete(link.id);
        rerender();
      };

      // ---- connect and link ----
      const connect = () => {
        const back = new URL(window.location.href);
        back.searchParams.set('libraries', p);
        window.location.assign(`${BASE}/api/libraries/${p}/connect?returnTo=${encodeURIComponent(back.pathname + back.search)}`);
      };

      const loadCollections = async () => {
        state.collections = [];
        if (!state.library) return;
        try {
          state.collections = collectionPaths(asList(await jfetch(`/api/libraries/${p}/collections?library=${encodeURIComponent(state.library)}`), 'collections', 'folders'));
        } catch { /* the whole library can still be linked */ }
      };

      const startPick = async () => {
        state.linking = true;
        rerender();
        try {
          state.libraries = asList(await jfetch(`/api/libraries/${p}/libraries`), 'libraries')
            .map((l) => ({ id: String(l.id ?? l.key ?? ''), name: String(l.name ?? l.id ?? '') })).filter((l) => l.id);
          state.library = state.libraries[0]?.id || '';
          state.collection = '';
          await loadCollections();
          const files = await jfetch(`/api/projects/${encodeURIComponent(pid)}/files?branch=${encodeURIComponent(aldine.project.branch)}`).catch(() => []);
          const taken = [...asList(files, 'files', 'entries').map((f) => (typeof f === 'string' ? f : f.path)), ...state.allLinks.map((l) => l.bibFile)];
          state.bibFile = defaultBibFile(p, taken.filter(Boolean), state.rootFile);
          state.view = 'pick';
        } catch (err) {
          aldine.toast(`${cfg.label}: ${err.message}`, 'error');
        }
        state.linking = false;
        rerender();
      };

      const createLink = async () => {
        const bibFile = normPath(state.bibFile.trim());
        if (!validBibFile(bibFile)) { aldine.toast('Choose a file name that ends in .bib', 'error'); return; }
        state.linking = true;
        rerender();
        const lib = state.libraries.find((l) => l.id === state.library);
        const coll = state.collections.find((c) => c.id === state.collection);
        try {
          const res = await jfetch(projectUrl, {
            method: 'POST',
            body: JSON.stringify({
              provider: p,
              branch: aldine.project.branch,
              library: state.library,
              libraryName: lib?.name,
              collection: state.collection || undefined,
              collectionName: coll?.path,
              recursive: state.recursive,
              bibFile,
              omitFields: [...state.omit],
            }),
          });
          const link = res.link || res;
          let job = null;
          if (res.jobId) job = await waitForJob(res.jobId);
          else if (link && link.id && !link.lastSyncedAt) job = await runSync({ ...link, bibFile }, 0).catch(() => null);
          const n = job?.itemCount;
          aldine.toast(`Imported ${n != null ? `${n} ` : ''}references from ${cfg.label} into ${bibFile}`, 'ok');
          state.view = 'main';
          await afterSync({ id: link?.id, bibFile }, job);
        } catch (err) {
          aldine.toast(`${cfg.label} link failed: ${err.message}`, 'error');
        }
        state.linking = false;
        rerender();
      };

      // ---- cite ----
      let bibSeq = 0;
      const loadBib = async () => {
        const seq = ++bibSeq;
        let entries;
        try {
          entries = await jfetch(`/api/projects/${encodeURIComponent(pid)}/bib?branch=${encodeURIComponent(aldine.project.branch)}`);
        } catch {
          entries = [];
        }
        if (seq !== bibSeq) return;
        const mine = new Set(state.links.map((l) => normPath(l.bibFile)));
        const list = Array.isArray(entries) ? entries : [];
        // Entries carry their file when the index says so; otherwise every entry is offered.
        state.bibEntries = list.some((e) => typeof e.file === 'string') ? list.filter((e) => mine.has(normPath(e.file))) : list;
        state.bibLoaded = true;
        rerender();
      };

      panel = { syncAll: () => { for (const link of state.links) syncLink(link); } };

      aldine.project.onFilesChanged?.(() => {
        if (state.bibLoaded && state.view === 'main') loadBib();
        else state.bibLoaded = false;
      });

      // ---- views ----
      const section = (label) => h('div', { class: 'menu__label', style: { padding: '8px 2px 4px' } }, label);
      const note = (text, testid) => h('p', { style: { color: 'var(--text-2)', fontSize: '12px', lineHeight: '1.5', margin: '0' }, dataset: testid ? { testid } : {} }, text);

      function linkCard(link) {
        const busy = state.busy.get(link.id);
        const source = link.collectionName ? `${link.libraryName || 'Library'} › ${link.collectionName}` : (link.libraryName || (link.linkedByName ? `${link.linkedByName}’s library` : 'Library'));
        return h('div', {
          dataset: { testid: tid('link') , linkId: link.id },
          style: { padding: '8px 10px', borderRadius: 'var(--radius-m)', background: 'var(--bg-inset)', display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '6px' },
        },
          h('div', { style: { fontSize: '12px' }, dataset: { testid: tid('linked') } }, `${source} → ${link.bibFile}`),
          h('div', { style: { fontSize: '11px', color: 'var(--text-2)' } },
            [link.linkedByName ? `Linked by ${link.linkedByName}` : null,
              link.lastSyncedAt ? `Last synced ${new Date(link.lastSyncedAt).toLocaleString()}` : 'Not synced yet',
              link.recursive === false ? 'Subfolders left out' : null].filter(Boolean).join(' · ')),
          link.pausedReason
            ? h('div', { style: { fontSize: '12px', padding: '6px 8px', borderRadius: 'var(--radius-s)', background: 'var(--warn-soft)' }, dataset: { testid: tid('paused') } }, `Paused: ${link.pausedReason}`)
            : null,
          state.canEdit
            ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              h('button', { class: 'btn btn--small', dataset: { testid: tid('sync') }, disabled: busy ? '' : null, onclick: () => syncLink(link) }, busy === 'syncing' ? 'Syncing…' : 'Sync now'),
              h('button', { class: 'btn btn--small btn--ghost', dataset: { testid: tid('unlink') }, disabled: busy ? '' : null, onclick: () => unlink(link) }, busy === 'unlinking' ? 'Unlinking…' : 'Unlink'),
            )
            : null,
        );
      }

      function build() {
        const wrap = h('div', { class: 'panel-list', dataset: { testid: tid('panel') }, style: { padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: '8px' } });

        if (state.view === 'loading') {
          wrap.append(h('div', { class: 'spinner', style: { margin: '20px auto' } }));
          return wrap;
        }
        if (state.view === 'unsupported') {
          wrap.append(section(cfg.label), note(`This server can’t link ${cfg.label} libraries yet. ${cfg.help}`, tid('unsupported')));
          return wrap;
        }

        if (state.view === 'pick') {
          wrap.append(section(`Link a ${cfg.label} ${cfg.folderWord}`));
          const libSelect = h('select', { class: 'input', style: { width: '100%' }, dataset: { testid: tid('library') }, 'aria-label': 'Library' },
            ...state.libraries.map((l) => h('option', { value: l.id }, l.name)));
          libSelect.value = state.library;
          libSelect.addEventListener('change', async () => { state.library = libSelect.value; state.collection = ''; await loadCollections(); rerender(); });
          const colSelect = h('select', { class: 'input', style: { width: '100%' }, dataset: { testid: tid('collection') }, 'aria-label': cfg.folderWord },
            h('option', { value: '' }, cfg.allItems),
            ...state.collections.map((c) => h('option', { value: c.id }, c.path)));
          colSelect.value = state.collections.some((c) => c.id === state.collection) ? state.collection : '';
          colSelect.addEventListener('change', () => { state.collection = colSelect.value; });
          const check = (testid, label, checked, onchange) => h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', { type: 'checkbox', dataset: { testid }, checked: checked ? '' : null, onchange: (e) => onchange(e.target.checked) }), label);
          wrap.append(
            libSelect,
            colSelect,
            check(tid('recursive'), `Include sub${cfg.folderWord}s`, state.recursive, (v) => { state.recursive = v; }),
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' } }, 'File',
              h('input', { class: 'input', value: state.bibFile, dataset: { testid: tid('bibfile') }, oninput: (e) => { state.bibFile = e.target.value; } })),
            h('div', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
              h('span', {}, 'Leave out'),
              ...OMIT_FIELDS.map((f) => check(tid(`omit-${f.id}`), f.label, state.omit.has(f.id), (v) => { if (v) state.omit.add(f.id); else state.omit.delete(f.id); }))),
            note('Everyone in this project can read the file. Each sync replaces it, so it opens read-only.'),
            h('button', { class: 'btn btn--primary', style: { width: '100%', justifyContent: 'center' }, dataset: { testid: tid('import') }, disabled: state.linking ? '' : null, onclick: createLink },
              state.linking ? 'Importing…' : `Import into ${normPath(state.bibFile) || 'the file'}`),
            h('button', { class: 'btn btn--ghost btn--small', dataset: { testid: tid('pick-cancel') }, onclick: () => { state.view = 'main'; rerender(); } }, 'Cancel'),
          );
          return wrap;
        }

        // main
        if (state.links.length) {
          wrap.append(section('Linked to this project'), ...state.links.map(linkCard));
        }
        const conn = state.connection;
        if (!conn?.connected) {
          if (!state.configured) {
            wrap.append(section(`Connect ${cfg.label}`), note(`${cfg.label} sign-in isn’t set up on this server yet. The administrator turns it on by registering a ${cfg.label} app. ${cfg.help}`, tid('unconfigured')));
          } else if (state.canEdit) {
            wrap.append(
              section(`Connect ${cfg.label}`),
              note(`Sign in to link a ${cfg.label} ${cfg.folderWord} to a .bib in this project. The connection belongs to your account and only reads your library.`),
              h('button', { class: 'btn btn--primary', style: { width: '100%', justifyContent: 'center' }, dataset: { testid: tid('connect') }, onclick: connect }, `Sign in with ${cfg.label}`),
            );
          }
        } else if (state.canEdit) {
          const full = state.allLinks.length >= MAX_LINKS;
          wrap.append(
            h('div', { style: { fontSize: '12px', color: 'var(--text-2)' }, dataset: { testid: tid('connected') } }, `Signed in to ${cfg.label}${conn.name ? ` as ${conn.name}` : ''}`),
            full
              ? note(`This project has ${MAX_LINKS} linked libraries, the most it can have. Unlink one to link another.`, tid('full'))
              : h('button', { class: 'btn btn--small', dataset: { testid: tid('add-link') }, disabled: state.linking ? '' : null, onclick: startPick },
                state.linking ? 'Loading…' : (state.links.length ? `Link another ${cfg.folderWord}` : `Link a ${cfg.folderWord}`)),
          );
        }
        if (state.loadError) wrap.append(note(`Couldn’t load the linked libraries: ${state.loadError}`, tid('error')));

        if (state.links.length) {
          wrap.append(
            section('Insert citation'),
            h('input', {
              class: 'input', placeholder: 'Search key, author, title…', style: { width: '100%' }, dataset: { testid: tid('search') }, value: state.searching,
              oninput: (e) => { state.searching = e.target.value; rerender(); },
              onfocus: () => { if (!state.bibLoaded) loadBib(); },
            }),
          );
          const q = state.searching.trim().toLowerCase();
          const matches = state.bibEntries
            .filter((e) => !q || e.key.toLowerCase().includes(q) || (e.author || '').toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q))
            .slice(0, 30);
          const list = h('div', {});
          for (const e of matches) {
            list.append(h('button', {
              class: 'tree__item', style: { height: 'auto', padding: '5px 8px', display: 'block' }, dataset: { testid: `${p}-cite-${e.key}` }, title: `Insert \\cite{${e.key}}`,
              onclick: () => citeToast(aldine, e.key, aldine.editor.insertCitation ? aldine.editor.insertCitation(e.key) : (aldine.editor.insertAtCursor(`\\cite{${e.key}}`), 'inserted')),
            },
              h('div', { style: { fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.key),
              h('div', { style: { color: 'var(--text-2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' } }, [e.author, e.year].filter(Boolean).join(' · ') || e.title || '')));
          }
          if (state.bibEntries.length && !matches.length) list.append(note('No matches.'));
          wrap.append(list);
        }
        return wrap;
      }

      // Back from the OAuth round trip (…?libraries=<p>): show this panel and tidy the address.
      try {
        const here = new URL(window.location.href);
        if (here.searchParams.get('libraries') === p) {
          here.searchParams.delete('libraries');
          window.history.replaceState(window.history.state, '', here.pathname + here.search + here.hash);
          setTimeout(() => aldine.ui.showPanel(p), 0);
        }
      } catch { /* no history: the panel just is not selected */ }

      rerender();
      load();
    },
  });
}
