import Modal from './Modal';
import { INSTANCE } from '../instance';
import { SOURCE_URL } from '../source';
import { SupportLink } from './Operator';
// Galley: About names Laytekz and credits Aldine (product.ts, ProductCredit.tsx).
import { PRODUCT_LINE, PRODUCT_NAME, UPSTREAM_COPYRIGHT } from '../product';
import { BasedOnAldine, PrivacyLink } from './ProductCredit';
import LogoMark from './LogoMark';

declare const __ALDINE_VERSION__: string;
declare const __ALDINE_REV__: string;

/**
 * AGPL section 13: anyone interacting with this instance over a network must be
 * offered the source of the version they are interacting with. That is what the
 * build stamp below is for — an operator running modified code points
 * SOURCE_URL at their own source (source.ts).
 */
export default function About({ onClose }: { onClose: () => void }) {
  const rev = __ALDINE_REV__;
  return (
    <Modal onClose={onClose} label={`About ${PRODUCT_NAME}`} testId="about-modal" width={460}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}><LogoMark size={28} />{PRODUCT_NAME}</h2>
      <p className="modal__sub">
        {PRODUCT_LINE}
        {rev ? <> Build <code>{rev}</code>.</> : null}
      </p>
      <p className="modal__sub" data-testid="about-upstream">
        <BasedOnAldine version={__ALDINE_VERSION__} />, with changes made for this site.
        {' '}Aldine {UPSTREAM_COPYRIGHT}.
      </p>
      <p className="modal__sub">
        Licensed under the{' '}
        <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noreferrer">
          GNU Affero General Public License v3
        </a>
        . You are entitled to the complete source of the version running here,
        including any changes this instance&rsquo;s operator has made to it.
      </p>
      <p className="modal__sub" data-testid="about-privacy">
        What this site stores about you, and why: <PrivacyLink testId="about-privacy-link" />.
      </p>
      {INSTANCE && (INSTANCE.name || INSTANCE.support) && (
        <p className="modal__sub" data-testid="about-operator">
          {INSTANCE.name && <>This instance is run by {INSTANCE.url ? <a href={INSTANCE.url} target="_blank" rel="noreferrer">{INSTANCE.name}</a> : INSTANCE.name}. </>}
          {INSTANCE.support && <>For help, contact <SupportLink />.</>}
        </p>
      )}
      <div className="modal__row">
        <button className="btn" onClick={onClose}>Close</button>
        <a
          className="btn btn--primary"
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          data-testid="about-source"
        >
          Get the source
        </a>
      </div>
    </Modal>
  );
}
