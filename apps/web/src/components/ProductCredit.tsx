import type { CSSProperties } from 'react';
import { withBase } from '../basePath';
import { PRIVACY_PATH, UPSTREAM_NAME, UPSTREAM_URL } from '../product';
import { SOURCE_URL } from '../source';

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

/** The sign-in card's last line: the credit, the source and the privacy page. */
export function SignInFinePrint() {
  return (
    <p style={finePrint} data-testid="sign-in-credit">
      <BasedOnAldine linkStyle={quietLink} />
      {' · '}
      <a href={SOURCE_URL} target="_blank" rel="noreferrer" style={quietLink} data-testid="sign-in-source">Source code</a>
      {' · '}
      <PrivacyLink testId="sign-in-privacy" style={quietLink} />
    </p>
  );
}
