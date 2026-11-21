import type { SVGProps } from 'react';

/**
 * Galley: Laytekz's mark, the app icon (desktop/build/icon.svg) drawn for UI
 * sizes from its 32 px source (icon-sources/icon-32.svg): a dark tile, a long
 * sheet of set lines running off its foot, and a proofreader's caret under
 * the gap in a line. Flat fills and no ids, so any number of copies can share
 * a page. The tile carries a faint light rim so it keeps its edge on the dark
 * theme's background. index.html's favicon is the same drawing.
 */
export default function LogoMark({ size = 20, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg viewBox="3 3 26 26" width={size} height={size} aria-hidden="true" focusable="false" {...rest}>
      <rect x="3.125" y="3.125" width="25.75" height="25.75" rx="6" fill="#2a2c32" />
      <path d="M10 28.875V6a.75.75 0 0 1 .75-.75h10.5A.75.75 0 0 1 22 6v22.875Z" fill="#f6f3ec" />
      <g fill="#33363d">
        <rect x="12" y="8" width="8" height="2" rx="0.6" />
        <rect x="12" y="12" width="4" height="2" rx="0.6" />
        <rect x="18" y="12" width="2" height="2" rx="0.6" />
        <rect x="14" y="20" width="6" height="2" rx="0.6" />
        <rect x="12" y="24" width="8" height="2" rx="0.6" />
      </g>
      <path d="M14.6 18.2 17 15.2l2.4 3" fill="none" stroke="#ef4a3a" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="miter" />
      <rect x="3.5" y="3.5" width="25" height="25" rx="5.6" fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="0.75" />
    </svg>
  );
}
