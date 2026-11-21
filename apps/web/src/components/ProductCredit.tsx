import type { CSSProperties } from 'react';
import { withBase } from '../basePath';
import { PRIVACY_PATH, UPSTREAM_NAME, UPSTREAM_URL } from '../product';
import { SOURCE_URL } from '../source';
// Galley: V2 (WP45) the About page and the desktop download link on the sign-in card.
import { useCapabilities } from '../settings/capabilities';
import { ABOUT_PATH, desktopLinkLabel, desktopUrlOf } from '../features/webShell/api';

/**
 * Galley: the credit and notices a modified Aldine owes its users, for the
 * places that show them. TRADEMARK.md: a modified version says "based on
 * Aldine". AGPL-3.0 section 13: the source of the running version (source.ts)
 * is offered wherever people first meet the app.
 */

/** "Based on Aldine", the name linking to the upstream project. */
export function BasedOnAldine({ version, linkStyle }: { version?: string; linkStyle?: CSSProperties }) {
  return (
    <>
      Based on <a href={UPSTREAM_URL} target="_blank" rel="noreferrer" style={linkStyle} data-testid="credit-upstream">{UPSTREAM_NAME}</a>
      {version ? ` ${version}` : null}
    </>
  );
}

/** The privacy page: a server-rendered page, so a full navigation, not a router link. */
export function PrivacyLink({ testId = 'privacy-link', style }: { testId?: string; style?: CSSProperties }) {
  return <a href={withBase(PRIVACY_PATH)} style={style} data-testid={testId}>Privacy</a>;
}

const finePrint: CSSProperties = {
  margin: '16px 0 0',
  color: 'var(--text-3)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.5,
  textAlign: 'center',
};
/** The project list's colophon links (home.css .shelf-page__colophon a), at rest. */
const quietLink: CSSProperties = {
  color: 'var(--text-2)',
  textDecoration: 'underline',
  textDecorationColor: 'var(--hairline-strong)',
  textUnderlineOffset: 2,
};

/** Galley: V2 (WP45) the desktop app's download, when the server names one and this is not the app itself. */
function DesktopDownload() {
  const url = desktopUrlOf(useCapabilities() as unknown as Record<string, unknown>);
  const label = url ? desktopLinkLabel(typeof navigator !== 'undefined' ? navigator.userAgent : '') : null;
  if (!url || !label) return null;
  return (
    <p style={{ ...finePrint, margin: '12px 0 0', fontSize: 'var(--text-sm)' }}>
      <a href={url} target="_blank" rel="noreferrer" style={quietLink} data-testid="sign-in-desktop">{label}</a>
    </p>
  );
}

/** The sign-in card's last line: the credit, the source and the privacy page. */
export function SignInFinePrint() {
  return (
    <>
    <DesktopDownload />{/* Galley: V2 (WP45) */}
    <p style={finePrint} data-testid="sign-in-credit">
      {/* Galley: V2 (WP45) the public About page (server-rendered, a full navigation) */}
      <a href={withBase(ABOUT_PATH)} style={quietLink} data-testid="sign-in-about">About</a>
      {' · '}
      <BasedOnAldine linkStyle={quietLink} />
      {' · '}
      <a href={SOURCE_URL} target="_blank" rel="noreferrer" style={quietLink} data-testid="sign-in-source">Source code</a>
      {' · '}
      <PrivacyLink testId="sign-in-privacy" style={quietLink} />
    </p>
    </>
  );
}
