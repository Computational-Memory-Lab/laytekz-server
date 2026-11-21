import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link, useParams } from 'react-router-dom';
import Home from './pages/Home';
import { BASE_PATH } from './basePath';
import { ToastProvider } from './components/Toast';
import { DialogProvider } from './components/Dialogs';
import { AuthProvider } from './components/Auth';
import ErrorBoundary from './components/ErrorBoundary';
import { startThemeSync } from './theme';
// before the router: the editor's Back/Forward guard must hear a popstate first
import './editor/leaveGuard';
import { useDocumentTitle } from './util/documentTitle';
// Galley: V2 page host (WP06): the settings store, the app context, settings routes, feature modules.
import { startSettings } from './settings/store';
import { AppBridge, OpenSettingsBridge, loadFeatures } from './features/host';
import { editorSubpage } from './features/pageCtx';
import { SettingsConflictToast } from './components/settings/actions'; // Galley: V2 (WP23)
import './theme.css';
import './app.css';
import './home.css';

// The editor brings CodeMirror, pdf.js, KaTeX and Yjs, most of the app's
// code: the project list must not wait for it.
const loadEditor = () => import('./pages/Editor');
const Editor = lazy(loadEditor);
const OAuthConsent = lazy(() => import('./pages/OAuthConsent'));
const Admin = lazy(() => import('./pages/Admin'));
const Invite = lazy(() => import('./pages/Invite'));

/** One editor per project: from one project straight to another, nothing of the
 *  first (its tree, its open file, its connections) carries over. */
function ProjectEditor() {
  // Galley: V2 /p/:id/* also matches the settings page over the editor
  // (/p/<id>/settings/<section>), which keeps this same element, so opening
  // and closing it never remounts the editor; any other subpath is not a page.
  const { id = '', '*': subpath } = useParams();
  if (editorSubpage(subpath).kind === 'unknown') return <NotFound />;
  return <Editor key={id} />;
}

function NotFound() {
  useDocumentTitle('Page not found');
  return (
    <main className="notfound">
      <h1>Page not found</h1>
      <p>That page doesn’t exist.</p>
      <Link className="btn btn--primary" to="/">Back to your projects</Link>
    </main>
  );
}

startThemeSync();
// Galley: V2 settings store (storage listener, account sync, apply), once per tab.
try { startSettings(); } catch (err) { console.warn('[laytekz] settings could not start', err); }

// Galley: V2 (WP45) behind the unsupported-browser notice (index.html), the app mounts on "Continue anyway".
declare global { interface Window { __laytekzUnsupported?: boolean; __laytekzMount?: () => void } }
let mounted = false;
const mount = () => {
  if (mounted) return;
  mounted = true;
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ToastProvider>
       <DialogProvider>
        <AuthProvider>
          <AppBridge />{/* Galley: V2 app context */}
          <BrowserRouter basename={BASE_PATH} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <OpenSettingsBridge />{/* Galley: V2 openSettings() → the settings route */}
            <SettingsConflictToast />{/* Galley: V2 "Keep this browser's" after a sign-in (WP23) */}
            <Suspense fallback={<div className="page-loading" />}>
              <Routes>
                <Route path="/" element={<Home />} />
                {/* Galley: V2 settings routes; Home and the editor draw the page over themselves */}
                <Route path="/settings/*" element={<Home />} />
                <Route path="/p/:id/*" element={<ProjectEditor />} />
                <Route path="/oauth/authorize" element={<OAuthConsent />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/invite/:id" element={<Invite />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </AuthProvider>
       </DialogProvider>
      </ToastProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
};
if (window.__laytekzUnsupported) window.__laytekzMount = mount;
else mount();

// Opening a project is the usual next step: fetch the editor once the page
// has settled, so the first project opens without waiting for it.
const idle = (cb: () => void) => (typeof window.requestIdleCallback === 'function'
  ? window.requestIdleCallback(cb, { timeout: 5000 })
  : window.setTimeout(cb, 1500));
const prefetchEditor = () => idle(() => {
  loadEditor().catch(() => { /* the route retries when it is visited */ });
  // Galley: V2 the feature modules share the editor's code; other pages install them from here (boot, home slots).
  loadFeatures().catch(() => { /* the editor installs them itself */ });
});
if (document.readyState === 'complete') prefetchEditor();
else window.addEventListener('load', prefetchEditor, { once: true });
