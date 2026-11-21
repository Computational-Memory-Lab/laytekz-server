/**
 * F6 web readiness (WP45): the public pages the server renders itself, in
 * the same script-free shell as the sign-in pages and /privacy (routes.ts
 * authPage), so link previews, Google's brand check and browsers without
 * JavaScript can read them.
 */
import { PRODUCT_NAME, UPSTREAM_NAME, UPSTREAM_URL, isProductName, productTitle } from '../../product.js';
import type { InstanceInfo } from '../../instance.js';

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** GALLEY_DESKTOP_URL when it is an https URL (the desktop releases page); anything else is unset. */
export function desktopUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.GALLEY_DESKTOP_URL || '').trim();
  if (!raw || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The shell: the same palette and type as routes.ts authPage, reading width. */
export function shell(title: string, operator: string | null, main: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · ${esc(productTitle(operator))}</title><style>
:root{color-scheme:light dark;--bg:#f7f6f3;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e3e0da;--accent:#2f5d8a}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe8;--muted:#a3a09a;--card:#1f1f1c;--line:#34332f;--accent:#8fb5dc}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:0 16px}
main{max-width:40rem;width:100%;margin:32px 0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px 28px;box-sizing:border-box}
h1{font-size:1.1rem;margin:0 0 .5rem}h2{font-size:1rem;margin:1.5rem 0 .4rem}p{margin:0 0 1rem;color:var(--muted);overflow-wrap:anywhere}
a{color:var(--accent);font-weight:500}strong{color:var(--fg)}nav{margin-top:1.5rem;color:var(--muted)}
</style></head><body><main>${main}</main></body></html>`;
}

const contactHtml = (s: InstanceInfo['support']) => (!s ? null
  : s.kind === 'email' ? `<a href="mailto:${esc(s.value)}">${esc(s.value)}</a>`
  : `<a href="${esc(s.value)}">the support page</a>`);

export interface AboutInput {
  instance: InstanceInfo;
  basePath: string;
  approval: boolean;
  desktop: string | null;
  source: string | null;
}

/** /about: what Laytekz is, who runs this site, how accounts work, the desktop app, browsers. */
export function aboutPage(o: AboutInput): string {
  const operator = o.instance.name && !isProductName(o.instance.name) ? o.instance.name : null;
  const contact = contactHtml(o.instance.support);
  const home = `${o.basePath}/`;
  const parts: string[] = [];
  parts.push(`<h1 data-testid="about-title">About ${esc(PRODUCT_NAME)}</h1>`);
  parts.push(`<p>${esc(PRODUCT_NAME)} is a collaborative LaTeX editor: write together, see the PDF update as you type, and keep every version.</p>`);
  parts.push('<h2>Who runs this site</h2>');
  parts.push(`<p data-testid="about-operator">${operator ? `This site is run by <strong>${esc(operator)}</strong> on a private server.` : 'This site runs on a private server.'}${contact ? ` To get in touch, write to ${contact}.` : ''}</p>`);
  parts.push('<h2>Getting an account</h2>');
  parts.push(o.approval
    ? `<p data-testid="about-approval">Sign in with your account. An administrator approves each new account by hand${contact ? ` (you can ask them at ${contact})` : ''}. Once you are approved, sign in again and your projects open.</p>`
    : '<p data-testid="about-approval">Sign in to see your projects, or open a link someone shared with you.</p>');
  if (o.desktop) {
    parts.push('<h2>Desktop app</h2>');
    parts.push(`<p>${esc(PRODUCT_NAME)} is also a desktop app for macOS and Windows, working with this same site. <a href="${esc(o.desktop)}" data-testid="about-desktop">Download the desktop app</a>.</p>`);
  }
  parts.push('<h2>Browsers</h2>');
  parts.push('<p>Use a current browser: Chrome or Edge 119 or later, Firefox 121 or later, or Safari 17.4 or later. Phones and tablets work too.</p>');
  parts.push('<h2>If the site does not load</h2>');
  parts.push(`<p>It is probably restarting after an update: try again in a minute. Everything you saved is kept on the server, and an editor that is already open keeps your edits and saves them when the connection comes back.</p>`);
  parts.push(`<nav><a href="${esc(home)}" data-testid="about-back">Back to ${esc(PRODUCT_NAME)}</a> · <a href="${esc(`${o.basePath}/privacy`)}" data-testid="about-privacy">Privacy</a> · <a href="${esc(o.source || UPSTREAM_URL)}">Source code</a> · Based on <a href="${esc(UPSTREAM_URL)}">${esc(UPSTREAM_NAME)}</a></nav>`);
  return shell('About', o.instance.name, parts.join(''));
}

export interface WaitingInput {
  /** The refusal as V1 worded it (kept word for word under its test id). */
  message: string;
  account: string | null;
  support: InstanceInfo['support'];
  /** The server mails the approval (email configured, public URL known). */
  mailsApproval: boolean;
  /** The administrators were told (approval requests are mailed to them). */
  adminsTold: boolean;
  /** The sign-in came from the desktop app's handoff. */
  desktop: boolean;
  basePath: string;
}

/** The main part of the waiting-for-approval page: the address, who approves, how to hear back, the next step. */
export function waitingMain(o: WaitingInput): string {
  const contact = contactHtml(o.support);
  const parts: string[] = ['<h1>Waiting for approval</h1>'];
  parts.push(`<p data-testid="sign-in-error">${esc(o.message)}</p>`);
  if (o.account) parts.push(`<p data-testid="waiting-account">Your ${esc(PRODUCT_NAME)} account for <strong>${esc(o.account)}</strong> is set up. It needs an administrator's approval before it can open any projects.</p>`);
  const next = o.mailsApproval && o.account
    ? `You will get an email at <strong>${esc(o.account)}</strong> when it is approved. Then sign in here again.`
    : contact
      ? `To ask about it, write to ${contact}. Once you are approved, sign in here again.`
      : 'Once you are approved, sign in here again. If you are still waiting after a day, ask the person who invited you to this site.';
  parts.push(`<p data-testid="waiting-next">${next}${o.adminsTold ? ' The administrator has been told that you are waiting.' : ''}</p>`);
  if (o.desktop) parts.push(`<p data-testid="waiting-desktop">Once you are approved, go back to the ${esc(PRODUCT_NAME)} desktop app and sign in again there. You can close this tab.</p>`);
  parts.push(`<p><a data-testid="sign-in-error-back" href="${esc(`${o.basePath}/`)}">Back to sign-in</a> · <a href="${esc(`${o.basePath}/about`)}" data-testid="waiting-about">About this site</a> · <a href="${esc(`${o.basePath}/privacy`)}">Privacy</a></p>`);
  return parts.join('');
}

/** RFC 9116 security.txt: the support contact, or null when there is none (the route then answers 404). */
export function securityTxt(support: InstanceInfo['support'], canonical: string | null, now = new Date()): string | null {
  if (!support) return null;
  const contact = support.kind === 'email' ? `mailto:${support.value}` : support.value;
  const expires = new Date(now.getTime() + 180 * 24 * 3600 * 1000);
  expires.setUTCHours(0, 0, 0, 0);
  const lines = [`Contact: ${contact}`, `Expires: ${expires.toISOString()}`, 'Preferred-Languages: en'];
  if (canonical) lines.push(`Canonical: ${canonical}`);
  return `${lines.join('\n')}\n`;
}
