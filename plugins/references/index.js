/**
 * Galley: V2 (WP22) rewritten from V1's "Cite" panel; the project list and its test ids are kept.
 *
 * The References panel (Laytekz V2, WP22): one box that searches papers or
 * takes a DOI, arXiv ID, PubMed ID, ISBN, a formatted citation or pasted
 * BibTeX; a preview sheet with the exact entry, an editable key and the .bib
 * it goes to; Add (and cite at the cursor), with Undo; a Google Scholar
 * link-out the user's own browser opens; and the citations the last typeset
 * left undefined. The server does the lookups and writes
 * (/api/projects/:id/references/{lookup,preview,insert,remove}).
 *
 * The V2 host additions (settings, citeWithHandle/revert, toast actions,
 * canEdit, onCompiled, onQuery) are optional: on an older host the panel
 * falls back to the V1 calls.
 */
import {
  looksLikeBibtex, MIN_SEARCH, undefinedCitations, keyToQuery, setEntryKey, validKey,
  byline, badges, previewBody, targetChoices, newBibPath, addedText, undoneText,
} from './core.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

const SETTING = {
  online: 'references.online',
  preview: 'references.preview',
  cite: 'references.citeAtCursor',
};
const NEW_FILE = '\u0000new';
const FILTERS = [['all', 'All'], ['medicine', 'Medicine'], ['datasets', 'Datasets']];
const ID_KINDS = new Set(['doi', 'arxiv', 'pmid', 'pmcid', 'isbn', 'openalex']);
const NOT_UTF8 = 'This .bib isn’t UTF-8, so adding to it would damage it. Choose another file.';

/** Cite `key` at the cursor: { result, handle }. result is false when no TeX file is open. */
const cite = (aldine, key) => {
  if (aldine.editor.citeWithHandle) return aldine.editor.citeWithHandle(key);
  if (aldine.editor.insertCitation) return { result: aldine.editor.insertCitation(key) || false, handle: null };
  aldine.editor.insertAtCursor(`\\cite{${key}}`);
  return { result: 'inserted', handle: null };
};

/** What a citation pick did, as the toast says it. */
const citedText = (key, result) => (result === 'added' ? `added ${key} to the citation`
  : result === 'present' ? `${key} is in this citation already`
  : `inserted \\cite{${key}}`);

export default {
  activate(aldine) {
    const setting = (id, fallback) => {
      const v = aldine.settings?.get(id);
      return typeof v === 'boolean' ? v : fallback;
    };
    const canEdit = () => (aldine.project.canEdit ? aldine.project.canEdit() !== false : true);
    const api = (path) => `/api/projects/${encodeURIComponent(aldine.project.id)}/references/${path}`;
    const post = async (path, body) => {
      const res = await aldine.fetch(api(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch: aldine.project.branch, ...body }),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    };

    // set once the panel has rendered
    let reload = () => {};
    let refreshMissing = () => {};
    let takeQuery = () => {};
    let focusSearch = () => {};
    let revealMissing = () => {};

    aldine.ui.registerSidebarPanel({
      id: 'references',
      title: 'References',
      // references typed into an open .bib since the last file-list change
      onShow: () => { reload(); refreshMissing(); },
      onQuery: (q) => takeQuery(q),
      render(root) {
        // ---- search state ----
        let query = '';
        let filter = 'all';
        let results = [];
        let sourceErrors = [];
        let notice = '';
        let scholarUrl = '';
        let searching = false;
        let searchSeq = 0;
        let searchAbort = null;
        let searchStatus = '';
        let searchTimer = null;
        /** Set by "Find" on an undefined citation: the key the added entry should get. */
        let missingKey = null;
        // ---- preview state: null, or the sheet for one candidate ----
        let preview = null;
        let previewSeq = 0;
        let previewTimer = null;

        // ---- the project's own bibliography ----
        let bib = [];
        let bibLoaded = false;
        let bibFilterText = '';
        let bibSeq = 0;
        let missing = [];

        const loadBib = async () => {
          const seq = ++bibSeq;
          let entries;
          try {
            const res = await aldine.fetch(`/api/projects/${aldine.project.id}/bib?branch=${encodeURIComponent(aldine.project.branch)}`);
            entries = res.ok ? await res.json() : [];
          } catch { entries = []; }
          if (seq !== bibSeq) return;
          // one row per key: LaTeX resolves a key once, whichever file holds it
          bib = [...new Map((Array.isArray(entries) ? entries : []).map((e) => [e.key, e])).values()];
          bibLoaded = true;
          drawBib();
          drawMissing();
        };
        aldine.project.onFilesChanged?.(loadBib);
        reload = loadBib;

        const insertKey = (key) => {
          const { result } = cite(aldine, key);
          if (result) aldine.toast(citedText(key, result).replace(/^./, (c) => c.toUpperCase()), 'ok');
          else aldine.toast(`Open a .tex file and put the cursor where \\cite{${key}} goes`, 'error');
        };

        // ---- styles ----
        const line1 = { fontWeight: '600', fontSize: '12.5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
        const line2 = { color: 'var(--text-2)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
        const small = { color: 'var(--text-2)', fontSize: '12px', padding: '2px 4px', margin: 0 };
        const label = (text, top) => h('div', { class: 'menu__label', style: { padding: `${top ? 10 : 0}px 2px 0` } }, text);
        const badgeStyle = (kind) => ({
          display: 'inline-block', fontSize: '10.5px', lineHeight: '15px', padding: '0 5px', marginRight: '4px', marginTop: '3px',
          borderRadius: 'var(--radius-xs, 3px)', border: '1px solid var(--hairline-strong, var(--hairline))',
          color: kind === 'project' ? 'var(--ok-text, var(--text))' : kind === 'warn' ? 'var(--warn-text, var(--text))' : 'var(--text-2)',
          background: kind === 'project' ? 'var(--accent-soft, transparent)' : kind === 'warn' ? 'var(--warn-soft, transparent)' : 'transparent',
        });

        // ---- inputs, built once so redraws keep focus and the caret ----
        const bibFilter = h('input', {
          class: 'input',
          placeholder: 'Filter by key, author, title…',
          style: { width: '100%' },
          dataset: { testid: 'cite-bib-filter' },
          oninput: (e) => { bibFilterText = e.target.value; drawBib(); },
        });
        const bibList = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' }, dataset: { testid: 'cite-bib-list' } });
        const missingBox = h('div', { style: { display: 'none', flexDirection: 'column', gap: '4px' }, dataset: { testid: 'references-missing' } });

        const searchInput = h('textarea', {
          class: 'input',
          rows: '1',
          spellcheck: 'false',
          'aria-label': 'Search papers, or paste a DOI, arXiv ID, PubMed ID, ISBN, a citation or BibTeX',
          style: { width: '100%', resize: 'none', minHeight: 'var(--control-h, 28px)', fontFamily: 'inherit', lineHeight: '1.35', padding: '5px 8px', overflowY: 'auto' },
          dataset: { testid: 'reference-search' },
          oninput: (e) => onSearchInput(e.target.value),
          onkeydown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); runSearch(true); }
          },
        });
        // The V1 test id: this button was "Add & cite" beside the identifier box.
        const searchButton = h('button', {
          class: 'btn',
          style: { flex: 'none' },
          dataset: { testid: 'reference-add' },
          onclick: () => runSearch(true),
        }, 'Search');
        const chips = h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, dataset: { testid: 'reference-filters' } });
        const statusBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
        const hits = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '260px', overflowY: 'auto' }, dataset: { testid: 'reference-hits' } });
        const scholarBox = h('div', {});
        const sheet = h('div', { style: { display: 'none', flexDirection: 'column', gap: '8px' }, dataset: { testid: 'reference-preview' } });

        const sizeSearch = () => {
          const lines = Math.min(6, Math.max(1, searchInput.value.split('\n').length));
          searchInput.rows = lines;
        };
        const setQuery = (q) => { query = q; searchInput.value = q; sizeSearch(); };

        // ---- search ----
        const clearResults = () => { results = []; sourceErrors = []; notice = ''; scholarUrl = ''; searchStatus = ''; };
        const onSearchInput = (v) => {
          query = v;
          missingKey = null;
          sizeSearch();
          if (searchTimer) clearTimeout(searchTimer);
          // pasted BibTeX goes straight to the preview; anything else waits for a pause
          searchTimer = setTimeout(() => runSearch(false), looksLikeBibtex(v) ? 150 : 600);
        };

        async function runSearch(asked) {
          if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
          const q = query.trim();
          if (looksLikeBibtex(q)) {
            searchAbort?.abort();
            searching = false; clearResults(); draw();
            if (canEdit()) openPreview({ id: 'pasted', title: 'Pasted BibTeX', bibtex: q });
            else { searchStatus = 'Only editors can add references to this project.'; draw(); }
            return;
          }
          if (!setting(SETTING.online, true)) {
            searchAbort?.abort();
            searching = false; clearResults();
            if (q) searchStatus = 'Online lookup is off. Paste BibTeX to add it, or turn lookup on in Settings.';
            draw();
            return;
          }
          if (q.length < (asked ? 1 : MIN_SEARCH)) { searchAbort?.abort(); searching = false; clearResults(); draw(); return; }
          searchAbort?.abort();
          const ctl = typeof AbortController === 'function' ? new AbortController() : null;
          searchAbort = ctl;
          const seq = ++searchSeq;
          searching = true; clearResults(); closePreview(false); draw();
          let res; let body = null;
          try {
            res = await aldine.fetch(`${api('lookup')}?q=${encodeURIComponent(q)}&filter=${filter}&branch=${encodeURIComponent(aldine.project.branch)}`, ctl ? { signal: ctl.signal } : undefined);
            body = await res.json().catch(() => null);
          } catch (err) {
            if (err?.name === 'AbortError' || seq !== searchSeq) return;
            searching = false; searchStatus = 'Search failed: could not reach the server.'; draw();
            return;
          }
          if (seq !== searchSeq) return;
          searching = false;
          const msg = typeof body?.error === 'string' && body.error ? body.error : '';
          if (res.status === 401) searchStatus = 'Sign in to search online.';
          else if (res.status === 404) searchStatus = msg || 'Online reference lookup is off on this server.';
          else if (!res.ok) searchStatus = `Search failed: ${msg || 'the search did not return results'}`;
          else {
            results = Array.isArray(body?.results) ? body.results : [];
            sourceErrors = Array.isArray(body?.errors) ? body.errors : [];
            notice = typeof body?.notice === 'string' ? body.notice : '';
            scholarUrl = typeof body?.scholarUrl === 'string' && /^https:\/\/scholar\.google\.com\//.test(body.scholarUrl) ? body.scholarUrl : '';
            if (!results.length) searchStatus = 'No papers match that search.';
            // A pasted identifier names one paper: show it at once.
            else if (ID_KINDS.has(body?.kind) && results.length === 1 && canEdit() && setting(SETTING.preview, true)) {
              draw();
              openPreview(results[0]);
              return;
            }
          }
          draw();
        }

        const choose = (c) => {
          if (!canEdit()) return;
          if (setting(SETTING.preview, true)) openPreview(c);
          else quickAdd(c);
        };

        // ---- preview sheet ----
        function closePreview(redraw = true) {
          preview = null;
          ++previewSeq;
          if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
          if (redraw) draw();
        }

        async function openPreview(c) {
          const seq = ++previewSeq;
          preview = { candidate: c, loading: true, error: '', data: null, bibtex: '', key: '', bibFile: '', newFile: 'references.bib', cite: setting(SETTING.cite, true), loadBib: true, busy: false };
          if (missingKey) preview.cite = false;
          draw();
          const r = await post('preview', { ...previewBody(c), ...(missingKey ? { key: missingKey } : {}) }).catch(() => null);
          if (seq !== previewSeq || !preview) return;
          preview.loading = false;
          if (!r) { preview.error = 'Could not reach the server.'; draw(); return; }
          if (!r.ok) { preview.error = r.status === 401 ? 'Sign in to add references.' : (r.data?.error || `The preview failed (HTTP ${r.status}).`); draw(); return; }
          applyPreview(r.data, true);
          draw();
        }

        /** Take a preview answer; `fresh` also takes its text and key (not while the user is editing them). */
        function applyPreview(data, fresh) {
          preview.data = data;
          if (fresh || document.activeElement !== bibtexArea) preview.bibtex = data.bibtex || preview.bibtex;
          if (fresh) preview.key = data.duplicate ? data.duplicate.key : data.key;
          if (fresh && preview.bibFile !== NEW_FILE) preview.bibFile = data.bibFile;
        }

        const targetPath = () => (preview?.bibFile === NEW_FILE ? newBibPath(preview.newFile) : preview?.bibFile || '');
        const targetInfo = () => (preview?.data?.targets || []).find((t) => t.path === targetPath()) || null;

        /** Ask the server again after an edit: the key's note, the duplicate check, whether the file is loaded. */
        const schedulePreview = () => {
          if (previewTimer) clearTimeout(previewTimer);
          previewTimer = setTimeout(async () => {
            previewTimer = null;
            if (!preview || !preview.data) return;
            const bibFile = targetPath();
            const key = preview.key.trim();
            if (!bibFile || !validKey(key)) { draw(); return; }
            const seq = ++previewSeq;
            const r = await post('preview', { bibtex: preview.bibtex, key, bibFile }).catch(() => null);
            if (seq !== previewSeq || !preview) return;
            if (r?.ok) { preview.error = ''; applyPreview(r.data, false); }
            else preview.error = r?.data?.error || 'Could not check that entry.';
            drawSheet();
          }, 400);
        };

        const bibtexArea = h('textarea', {
          class: 'input',
          rows: '8',
          spellcheck: 'false',
          'aria-label': 'BibTeX entry',
          style: { width: '100%', fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-code, 12px)', lineHeight: '1.4', resize: 'vertical', whiteSpace: 'pre', padding: '6px 8px' },
          dataset: { testid: 'reference-preview-bibtex' },
          oninput: (e) => { if (preview) { preview.bibtex = e.target.value; schedulePreview(); } },
        });
        const keyInput = h('input', {
          class: 'input',
          spellcheck: 'false',
          'aria-label': 'Citation key',
          style: { width: '100%', fontFamily: 'var(--font-mono, monospace)' },
          dataset: { testid: 'reference-preview-key' },
          oninput: (e) => {
            if (!preview) return;
            preview.key = e.target.value;
            if (validKey(preview.key.trim())) {
              preview.bibtex = setEntryKey(preview.bibtex, preview.key.trim());
              bibtexArea.value = preview.bibtex;
            }
            drawSheetNotes();
            schedulePreview();
          },
        });
        const targetSelect = h('select', {
          class: 'input',
          'aria-label': 'Add to',
          style: { width: '100%' },
          dataset: { testid: 'reference-preview-target' },
          onchange: (e) => { if (preview) { preview.bibFile = e.target.value; drawSheet(); schedulePreview(); } },
        });
        const newFileInput = h('input', {
          class: 'input',
          placeholder: 'refs/new.bib',
          'aria-label': 'New .bib file',
          style: { width: '100%' },
          dataset: { testid: 'reference-preview-newfile' },
          oninput: (e) => { if (preview) { preview.newFile = e.target.value; drawSheetNotes(); schedulePreview(); } },
        });
        const citeBox = h('input', { type: 'checkbox', dataset: { testid: 'reference-preview-cite' }, onchange: (e) => { if (preview) preview.cite = e.target.checked; } });
        const loadBox = h('input', { type: 'checkbox', dataset: { testid: 'reference-preview-loadbib' }, onchange: (e) => { if (preview) preview.loadBib = e.target.checked; } });
        const loadText = h('span', {});
        const loadRow = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, loadBox, loadText);
        const citeRow = h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, citeBox, 'Cite at the cursor');
        const keyNote = h('p', { style: { ...small, padding: '0 2px' }, dataset: { testid: 'reference-preview-keynote' } });
        const dupNote = h('p', { style: { ...small, padding: '0 2px', color: 'var(--text)' }, dataset: { testid: 'reference-preview-duplicate' } });
        const targetNote = h('p', { style: { ...small, padding: '0 2px', color: 'var(--error, var(--text))' }, dataset: { testid: 'reference-preview-target-note' } });
        const sheetError = h('p', { style: { ...small, padding: '0 2px', color: 'var(--error, var(--text))' }, dataset: { testid: 'reference-preview-error' } });
        const sheetTitle = h('div', { style: { ...line1, whiteSpace: 'normal' } });
        const sheetByline = h('div', { style: { ...line2, whiteSpace: 'normal' } });
        const buttons = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } });

        function drawSheetNotes() {
          if (!preview) return;
          const d = preview.data;
          const key = preview.key.trim();
          const badKey = key && !validKey(key);
          keyNote.textContent = badKey ? 'A citation key cannot contain spaces, commas, braces, quotes or #%~\\.' : (d?.keyNote && !d?.duplicate ? d.keyNote : '');
          keyNote.style.display = keyNote.textContent ? '' : 'none';
          dupNote.textContent = d?.duplicate ? `Already in ${d.duplicate.bibFile} as ${d.duplicate.key}.` : '';
          dupNote.style.display = dupNote.textContent ? '' : 'none';
          const info = targetInfo();
          const path = targetPath();
          targetNote.textContent = preview.bibFile === NEW_FILE && !path ? 'Type a file name ending in .bib.'
            : info && info.editable === false ? NOT_UTF8 : '';
          targetNote.style.display = targetNote.textContent ? '' : 'none';
          sheetError.textContent = preview.error || '';
          sheetError.style.display = preview.error ? '' : 'none';
          const loaded = info ? info.loaded : (preview.bibFile === NEW_FILE ? false : d?.loaded);
          loadRow.style.display = path && loaded === false ? 'flex' : 'none';
          loadText.textContent = `Load ${path || 'it'} in the main file`;
          const blocked = !path || badKey || !key || (info && info.editable === false) || preview.busy;
          for (const b of buttons.querySelectorAll('button[data-add]')) b.disabled = !!blocked;
        }

        function drawSheet() {
          if (!preview) { sheet.style.display = 'none'; return; }
          sheet.style.display = 'flex';
          const c = preview.candidate;
          sheetTitle.textContent = c.title || 'Reference';
          sheetByline.textContent = byline(c);
          const kids = [h('div', {}, sheetTitle, sheetByline)];
          if (preview.loading) {
            kids.push(h('div', { class: 'spinner', style: { margin: '6px auto' } }));
            kids.push(h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn btn--ghost', dataset: { testid: 'reference-preview-cancel' }, onclick: () => closePreview() }, 'Cancel')));
            sheet.replaceChildren(...kids, sheetError);
            drawSheetNotes();
            return;
          }
          if (!preview.data) {
            sheet.replaceChildren(...kids, sheetError,
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn btn--ghost', dataset: { testid: 'reference-preview-cancel' }, onclick: () => closePreview() }, 'Back')));
            drawSheetNotes();
            return;
          }
          if (document.activeElement !== bibtexArea) bibtexArea.value = preview.bibtex;
          if (document.activeElement !== keyInput) keyInput.value = preview.key;
          // Add to: the editable .bib files (a synced one is never offered), then a new file
          const choices = targetChoices(preview.data.targets, preview.data.bibFile);
          targetSelect.replaceChildren(
            ...choices.map((t) => h('option', { value: t.path, disabled: t.editable === false }, `${t.path}${t.exists ? '' : ' (new)'}${t.editable === false ? ' (not UTF-8)' : ''}`)),
            h('option', { value: NEW_FILE }, 'New file…'),
          );
          targetSelect.value = preview.bibFile;
          newFileInput.style.display = preview.bibFile === NEW_FILE ? '' : 'none';
          citeBox.checked = !!preview.cite;
          loadBox.checked = !!preview.loadBib;
          const dup = preview.data.duplicate;
          const btns = dup
            ? [
              h('button', { class: 'btn btn--primary', dataset: { testid: 'reference-preview-cite-existing' }, onclick: () => citeExisting(dup) }, `Cite ${dup.key}`),
              h('button', { class: 'btn', dataset: { testid: 'reference-preview-add-anyway', add: '1' }, onclick: () => add(true) }, 'Add anyway'),
            ]
            : [h('button', { class: 'btn btn--primary', dataset: { testid: 'reference-preview-add', add: '1' }, onclick: () => add(false) }, preview.busy ? 'Adding…' : 'Add')];
          btns.push(h('button', { class: 'btn btn--ghost', dataset: { testid: 'reference-preview-cancel' }, onclick: () => closePreview() }, 'Cancel'));
          buttons.replaceChildren(...btns);
          sheet.replaceChildren(
            ...kids,
            dupNote,
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px' } }, 'Key', keyInput),
            keyNote,
            bibtexArea,
            h('label', { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px' } }, 'Add to', targetSelect),
            newFileInput,
            targetNote,
            citeRow,
            loadRow,
            sheetError,
            buttons,
          );
          drawSheetNotes();
        }

        // ---- adding and undoing ----
        const afterWrite = async () => {
          try { await aldine.project.refreshFiles(); } catch { /* the list refreshes on the next signal */ }
          loadBib();
        };

        function toastAdded(o) {
          const { key, bibFile, duplicate, entryHash, citeWanted, citeResult, handle, loadAdded } = o;
          let text = addedText({ key, bibFile, duplicate, cited: citeWanted && !!citeResult, citeResult });
          if (citeWanted && !citeResult) text += ` Open a .tex file and put the cursor where \\cite{${key}} goes.`;
          if (loadAdded?.file) text += ` ${loadAdded.file} now loads ${bibFile}.`;
          const undoable = (!duplicate && entryHash) || handle;
          const action = undoable ? { label: 'Undo', run: () => undo({ bibFile, entryHash: duplicate ? null : entryHash, handle }) } : undefined;
          aldine.toast(text, citeWanted && !citeResult ? 'info' : 'ok', action);
        }

        async function undo({ bibFile, entryHash, handle }) {
          let citeDone = null;
          if (handle && aldine.editor.revert) citeDone = aldine.editor.revert(handle);
          let entryDone = null;
          if (entryHash) {
            const r = await post('remove', { bibFile, entryHash }).catch(() => null);
            entryDone = !!(r && r.ok && r.data?.removed !== false);
            await afterWrite();
          }
          const failed = citeDone === false || entryDone === false;
          aldine.toast(undoneText({ entry: entryDone, cite: citeDone }), failed ? 'info' : 'ok');
        }

        function citeExisting(dup) {
          const { result, handle } = cite(aldine, dup.key);
          closePreview();
          if (result) aldine.toast(`${citedText(dup.key, result).replace(/^./, (c) => c.toUpperCase())}.`, 'ok', handle ? { label: 'Undo', run: () => undo({ bibFile: dup.bibFile, entryHash: null, handle }) } : undefined);
          else aldine.toast(`Open a .tex file and put the cursor where \\cite{${dup.key}} goes.`, 'info');
        }

        async function add(force) {
          if (!preview || !preview.data || preview.busy) return;
          const bibFile = targetPath();
          const key = preview.key.trim();
          if (!bibFile || !validKey(key)) { drawSheetNotes(); return; }
          const info = targetInfo();
          const loaded = info ? info.loaded : false;
          const citeWanted = !!preview.cite;
          preview.busy = true; drawSheet();
          const r = await post('insert', {
            bibtex: setEntryKey(preview.bibtex, key), key, bibFile,
            loadBib: !loaded && !!preview.loadBib, force: !!force,
          }).catch(() => null);
          if (!preview) return;
          preview.busy = false;
          if (!r || !r.ok) {
            preview.error = r ? (r.data?.code === 'not-utf8' ? NOT_UTF8 : r.data?.error || `Adding failed (HTTP ${r.status}).`) : 'Could not reach the server.';
            drawSheet();
            return;
          }
          const body = r.data;
          await finish(body, citeWanted);
        }

        async function finish(body, citeWanted) {
          closePreview();
          await afterWrite();
          let citeResult = null; let handle = null;
          if (citeWanted && body.key) ({ result: citeResult, handle } = cite(aldine, body.key));
          if (missingKey && body.key === missingKey) { missing = missing.filter((k) => k !== missingKey); missingKey = null; drawMissing(); }
          toastAdded({ ...body, citeWanted, citeResult, handle });
        }

        /** "Preview before adding" off: the preview's own entry, added at once. */
        async function quickAdd(c) {
          const r = await post('preview', { ...previewBody(c), ...(missingKey ? { key: missingKey } : {}) }).catch(() => null);
          if (!r || !r.ok) { aldine.toast(`Adding failed: ${r?.data?.error || 'could not reach the server'}`, 'error'); return; }
          const p = r.data;
          const citeWanted = setting(SETTING.cite, true) && !missingKey;
          if (p.duplicate) { if (citeWanted) citeExisting(p.duplicate); else aldine.toast(`${p.duplicate.key} is in ${p.duplicate.bibFile} already.`, 'info'); return; }
          const target = (p.targets || []).find((t) => t.path === p.bibFile);
          if (target && target.editable === false) { aldine.toast(NOT_UTF8, 'error'); return; }
          const w = await post('insert', { bibtex: p.bibtex, key: p.key, bibFile: p.bibFile, loadBib: false }).catch(() => null);
          if (!w || !w.ok) { aldine.toast(`Adding failed: ${w?.data?.error || 'could not reach the server'}`, 'error'); return; }
          await finish(w.data, citeWanted);
        }

        // ---- citations the last typeset left undefined ----
        refreshMissing = () => {
          try { missing = undefinedCitations(aldine.project.lastCompile()); } catch { missing = []; }
          drawMissing();
        };
        const findMissing = (key) => {
          setQuery(keyToQuery(key));
          // the entry added from this search takes the key the text already cites
          missingKey = key;
          runSearch(true);
        };
        function drawMissing() {
          // a key the project now has is no longer missing, even before the next typeset
          const have = new Set(bib.map((e) => e.key));
          const list = missing.filter((k) => !have.has(k));
          if (!list.length) { missingBox.style.display = 'none'; missingBox.replaceChildren(); return; }
          missingBox.style.display = 'flex';
          missingBox.replaceChildren(
            label(list.length === 1 ? '1 undefined citation' : `${list.length} undefined citations`),
            ...list.slice(0, 20).map((key) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '0 4px' } },
              h('code', { style: { flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: '11.5px' } }, key),
              h('button', {
                class: 'btn btn--ghost btn--small',
                title: `Search online for the paper ${key} names`,
                dataset: { testid: `references-missing-${key}` },
                onclick: () => findMissing(key),
              }, 'Find online'),
            )),
          );
        }
        revealMissing = () => {
          refreshMissing();
          if (missingBox.style.display !== 'none') missingBox.scrollIntoView?.({ block: 'nearest' });
          else aldine.toast('The last typeset reported no undefined citations.', 'info');
        };
        aldine.project.onCompiled?.(() => refreshMissing());

        // ---- drawing ----
        function drawBib() {
          const q = bibFilterText.trim().toLowerCase();
          const matches = bib.filter((e) => !q || [e.key, e.author, e.title, e.year].some((v) => String(v || '').toLowerCase().includes(q)));
          const rows = matches.slice(0, 50).map((e) => h('button', {
            class: 'tree__item',
            style: { height: 'auto', padding: '5px 8px', display: 'block' },
            dataset: { testid: `cite-bib-${e.key}` },
            title: `Insert \\cite{${e.key}}`,
            onclick: () => insertKey(e.key),
          },
            h('div', { style: line1 }, e.title || e.key),
            h('div', { style: line2 }, [e.key, e.author, e.year].filter(Boolean).join(' · ')),
          ));
          if (!bibLoaded) rows.push(h('div', { class: 'spinner', style: { margin: '6px auto' } }));
          else if (!bib.length) {
            rows.push(h('p', { style: small, dataset: { testid: 'cite-bib-empty' } },
              'No entries in this project’s .bib files yet. Search below to add one, or ',
              h('button', { class: 'link-button', style: { fontSize: '12px' }, dataset: { testid: 'cite-import-zotero' }, onclick: () => aldine.ui.showPanel('zotero') }, 'import from Zotero'),
              '.'));
          }
          else if (!matches.length) rows.push(h('p', { style: small }, 'No matches.'));
          else if (matches.length > 50) rows.push(h('p', { style: { ...small, fontSize: '11px' } }, `${matches.length - 50} more; narrow the filter.`));
          bibFilter.style.display = bib.length > 8 ? '' : 'none';
          bibList.replaceChildren(...rows);
        }

        function drawChips() {
          const online = setting(SETTING.online, true);
          chips.style.display = online ? 'flex' : 'none';
          chips.replaceChildren(...FILTERS.map(([id, text]) => h('button', {
            class: `btn btn--small ${filter === id ? 'btn--primary' : 'btn--ghost'}`,
            'aria-pressed': filter === id ? 'true' : 'false',
            dataset: { testid: `reference-filter-${id}` },
            onclick: () => { if (filter === id) return; filter = id; drawChips(); if (query.trim().length >= MIN_SEARCH && !looksLikeBibtex(query)) runSearch(true); },
          }, text)));
        }

        function drawHit(c) {
          const kids = [
            h('div', { style: { ...line1, whiteSpace: 'normal', display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical' } }, c.title || '(untitled)'),
            h('div', { style: line2 }, byline(c)),
          ];
          const b = badges(c);
          if (b.length) kids.push(h('div', {}, ...b.map((x) => h('span', { style: badgeStyle(x.kind) }, x.text))));
          const attrs = {
            class: 'tree__item',
            style: { height: 'auto', padding: '6px 8px', display: 'block', textAlign: 'left', width: '100%' },
            dataset: { testid: `search-hit-${c.id}` },
          };
          if (!canEdit()) return h('div', { ...attrs, style: { ...attrs.style, cursor: 'default' } }, ...kids);
          return h('button', { ...attrs, title: setting(SETTING.preview, true) ? 'Preview this reference' : 'Add this reference', onclick: () => choose(c) }, ...kids);
        }

        function draw() {
          const online = setting(SETTING.online, true);
          searchInput.placeholder = online ? 'Search papers, or paste a DOI, arXiv ID, PubMed ID, ISBN, a citation or BibTeX' : 'Paste BibTeX to add it';
          searchButton.textContent = online ? 'Search' : 'Add';
          drawChips();
          const status = [];
          if (!online) {
            status.push(h('p', { style: small, dataset: { testid: 'reference-online-off' } }, 'Online lookup is off. ',
              h('button', { class: 'link-button', style: { fontSize: '12px' }, dataset: { testid: 'reference-open-settings' }, onclick: () => (aldine.ui.openSettings ? aldine.ui.openSettings('references') : null) }, 'Settings')));
          }
          if (!canEdit()) status.push(h('p', { style: small, dataset: { testid: 'reference-viewer-note' } }, 'You can search, but only editors can add references to this project.'));
          if (notice) status.push(h('p', { style: small, dataset: { testid: 'reference-notice' } }, notice));
          if (sourceErrors.length) {
            status.push(h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' }, dataset: { testid: 'reference-source-errors' } },
              ...sourceErrors.map((e) => h('span', { style: badgeStyle('warn'), title: String(e?.message || ''), dataset: { testid: `reference-source-error-${e?.source}` } }, `${e?.source || 'A source'} did not answer`))));
          }
          statusBox.replaceChildren(...status);
          statusBox.style.display = status.length ? 'flex' : 'none';

          const showHits = !preview;
          hits.replaceChildren(
            ...(searching ? [h('div', { class: 'spinner', style: { margin: '6px auto' } })] : []),
            ...(searchStatus ? [h('p', { style: small, dataset: { testid: 'reference-search-status' } }, searchStatus)] : []),
            ...results.slice(0, 20).map(drawHit),
          );
          hits.style.display = showHits && (searching || results.length || searchStatus) ? 'flex' : 'none';
          scholarBox.replaceChildren(...(showHits && scholarUrl ? [h('a', {
            href: scholarUrl, target: '_blank', rel: 'noopener noreferrer', class: 'link-button',
            style: { fontSize: '12px', padding: '0 4px' }, dataset: { testid: 'reference-scholar' },
          }, 'Open in Google Scholar ↗')] : []));
          drawSheet();
          // The preview needs room: the find section grows over the project list while it is open.
          find.style.flex = preview ? '1 1 auto' : 'none';
          find.style.overflowY = preview ? 'auto' : '';
          project.style.flex = preview ? '0 1 30%' : '1';
        }

        takeQuery = (q) => {
          missingKey = null;
          closePreview(false);
          setQuery(String(q || ''));
          searchInput.focus();
          runSearch(true);
        };
        focusSearch = () => { searchInput.focus(); searchInput.select(); };

        // The project's entries scroll; search and add stay pinned below them.
        const project = h('div', { dataset: { testid: 'cite-project' }, style: { flex: '1', minHeight: '0', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', padding: '8px 6px' } },
          missingBox, label('In this project'), bibFilter, bibList,
        );
        const find = h('div', { dataset: { testid: 'cite-find' }, style: { flex: 'none', minHeight: '0', display: 'flex', flexDirection: 'column', gap: '8px', padding: '10px 6px 8px', borderTop: '1px solid var(--hairline)' } },
          label('Search online'),
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, searchInput, searchButton),
          chips, statusBox, hits, scholarBox, sheet,
        );
        root.replaceChildren(h('div', { class: 'panel-list', dataset: { testid: 'references-panel' }, style: { height: '100%', minHeight: '0' } }, project, find));
        aldine.settings?.onChange([SETTING.online, SETTING.preview], () => draw());
        draw();
        drawBib();
        loadBib();
        refreshMissing();
      },
    });

    aldine.ui.registerErrorsAction({
      id: 'find-missing-citations',
      label: 'Find missing citations',
      title: 'Search online for the papers behind undefined citations',
      run: () => { aldine.ui.showPanel('references'); revealMissing(); },
    });
    aldine.ui.registerCommand({
      id: 'references-search',
      title: 'Search online for a reference',
      group: 'References',
      keywords: 'bibtex doi arxiv pubmed isbn scholar cite add reference',
      run: () => { aldine.ui.showPanel('references'); setTimeout(() => focusSearch(), 0); },
    });
    aldine.ui.registerCommand({
      id: 'references-find-missing',
      title: 'Find missing citations online',
      group: 'References',
      keywords: 'undefined citation bibtex missing',
      run: () => { aldine.ui.showPanel('references'); revealMissing(); },
    });
  },
};
