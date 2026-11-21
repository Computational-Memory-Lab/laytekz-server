import type { CSSProperties, HTMLAttributes } from 'react';
import { PRODUCT_NAME } from '../product';
import LogoMark from './LogoMark';
import './Wordmark.css';

/**
 * Galley: Laytekz's wordmark, the mark followed by the name set in the UI
 * typeface (theme.css --font-ui) in the current text colour, so it follows
 * the theme. `height` is the mark's size; the name is sized to sit on it.
 * Replaces upstream's drawn "aldine." wordmark (brand/wordmark.svg), which
 * TRADEMARK.md reserves for Aldine itself.
 */
export default function Wordmark({ height = 20, title = PRODUCT_NAME, style, ...rest }: HTMLAttributes<HTMLSpanElement> & { height?: number; title?: string }) {
  const box: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: Math.round(height * 0.36),
    height,
    color: 'inherit',
    whiteSpace: 'nowrap',
    ...style,
  };
  const name: CSSProperties = {
    fontFamily: 'var(--font-ui)',
    fontSize: Math.round(height * 0.84),
    fontWeight: 650,
    letterSpacing: '-0.012em',
    lineHeight: 1,
  };
  return (
    <span role="img" aria-label={title} data-testid="wordmark" style={box} {...rest}>
      <LogoMark size={height} style={{ flex: 'none', display: 'block' }} />
      <span aria-hidden="true" style={name}>{PRODUCT_NAME}</span>
    </span>
  );
}
