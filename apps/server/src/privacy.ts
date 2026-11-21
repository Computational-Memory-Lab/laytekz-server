/**
 * Galley: the privacy page, served at <base path>/privacy (routes.ts) inside
 * the script-free shell of the sign-in pages, and linked from the sign-in
 * card and About.
 *
 * THE TEXT BELOW IS WRITTEN FOR latex.devon7y.com AS IT RUNS NOW (Google
 * sign-in only, no email, no AI features, no error tracking, nightly backups
 * on the same server, Cloudflare Tunnel in front). Change it whenever the
 * deployment changes. It is HTML: edit between the backticks, and do not type
 * a backtick or "${" inside. Two placeholders are filled in when the page is
 * served: {{product}} (the product name) and {{contact}} (how to reach the
 * operator, from the support contact in ALDINE_SUPPORT or /admin).
 */
import { PRODUCT_NAME } from './product.js';

export const PRIVACY_HTML = `
<h1>Privacy</h1>
<p>{{product}} is a LaTeX editor that the owner of this site runs on a single server. This page says what it keeps about you, where, and who else is involved.</p>

<h2>What is stored</h2>
<ul>
<li>From your Google account, when you sign in: your name, your email address and your profile picture. The server keeps its own copy of the picture.</li>
<li>Your account: when it was created and when you last used it.</li>
<li>If you connect them: your Zotero key and your Mendeley sign-in tokens, kept with your account and never shown to anyone. A library you link to a project is copied into a .bib file in it, which everyone who can open the project can read; abstracts, attached files and tags are left out unless you keep them.</li>
<li>What you make here: your projects and their files, their history (every saved version), comments, and the email addresses of people you share a project with or invite.</li>
<li>Only if you add them: the access token of a GitHub, GitLab or Gitea account you link to a project, and your Zotero key.</li>
<li>If you keep them in your account: your settings (appearance, editor and typing preferences, keyboard shortcuts), so every browser you sign in on uses them. Turn off “Keep my settings in my account” to keep them in this browser only. Project settings are stored with the project and seen by everyone who can open it.</li>
<li>If you turn on the desk pet: its settings are kept in your account like your other settings. The pet image is supplied by whoever runs this server and is shown only to signed-in people who turn it on; nothing about the pet is shared with your collaborators.</li>
<li>If you start Claude Code or Codex from the desktop app's console: an access token for that one project, named after this server and the project. It is listed under Agent access in your account settings, where you can revoke it. The desktop app keeps it on your computer, encrypted with the system keychain, and gives it only to the agent it starts.</li>
</ul>

<h2>Where it is stored</h2>
<p>Everything is stored on one server operated by the owner of this site. A backup is made every night on the same server, and the newest 14 are kept. The server also writes technical logs, which can include your email address, for example when a new account waits for approval. The operator can access everything on the server. Nothing is sold, and nothing is shared with anyone except as this page describes.</p>
<p>People you share a project with see that project, its history and its comments, with your name and picture next to your edits and comments.</p>

<h2>Other companies involved</h2>
<ul>
<li><strong>Google</strong>, for sign-in. When you sign in, Google tells this site your name, email address and profile picture. What Google itself keeps is covered by Google's privacy policy.</li>
<li><strong>Cloudflare</strong>, which carries all traffic between your browser and the server. It sees your IP address and the requests your browser makes.</li>
<li>Only when you use these features: GitHub, GitLab or Gitea when you push or pull a project you linked; Zotero or Mendeley when you connect, sync or search your library (Mendeley only if the operator turned it on): they receive your key or sign-in tokens and which library to read; doi.org, Crossref, OpenAlex, arXiv, PubMed, DataCite and Open Library (and Semantic Scholar, if the operator turned it on) when you look up a reference: they receive what you typed or pasted, never your name or address; a publisher's website when you start a project from a venue's official kit. The server contacts them for you.</li>
<li>Only if you turn on “Smarter suggestions” in Settings: the suggestion model is downloaded once from Hugging Face (huggingface.co and its hf.co download servers), without cookies. Suggestions are then made in your browser, and nothing you type is sent anywhere.</li>
<li>Claude Code and Codex, if you start them from the desktop app, run on your computer under your own Anthropic or OpenAI account and reach your project through this server. What they send to Anthropic or OpenAI is between you and that company; {{product}} sends those companies nothing.</li>
</ul>

<h2>Cookies</h2>
<p>This site sets one cookie that keeps you signed in, plus short-lived cookies that are used only while you sign in. There are no analytics, advertising or tracking cookies. Your browser also keeps settings such as the theme and the layout in its own storage on your computer.</p>

<h2>Deleting your data</h2>
<p>You can delete your own projects. A deleted project stays in the trash for 30 days, then it is removed. Copies can remain in the backups until the newest 14 no longer include them, about two weeks later.</p>
<p>To have your account and everything in it deleted, {{contact}}.</p>
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** How to reach the operator, as the end of "To have your account … deleted, …". */
function contactHtml(support: { kind: 'email' | 'url'; value: string } | null): string {
  if (!support) return 'ask the person who invited you to this site';
  if (support.kind === 'email') return `write to <a href="mailto:${esc(support.value)}">${esc(support.value)}</a>`;
  return `ask through <a href="${esc(support.value)}">the support page</a>`;
}

/** The page's body, for the sign-in pages' shell; `home` is the app's address on this origin. */
export function privacyPage(support: { kind: 'email' | 'url'; value: string } | null, home: string): string {
  return PRIVACY_HTML
    .replaceAll('{{product}}', esc(PRODUCT_NAME))
    .replaceAll('{{contact}}', contactHtml(support))
    .trim()
    + `\n<p><a href="${esc(home)}" data-testid="privacy-back">Back to ${esc(PRODUCT_NAME)}</a></p>`;
}
