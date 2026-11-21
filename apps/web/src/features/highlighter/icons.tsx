import type { SVGProps } from 'react';

/** A marker pen; `bar` draws a stripe under it in the current colour (the split button). */
export function IconHighlighter({ bar, ...p }: SVGProps<SVGSVGElement> & { bar?: string }) {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...p}>
      <path d="M9.5 2.5 13 6l-5.5 5.5H4.5V8.5Z" />
      <path d="m4.5 11.5-1.5 1.5" />
      <path d="M8 4l4 4" />
      {bar && <rect x="1.5" y="13.75" width="13" height="1.75" rx="0.6" stroke="none" fill={bar} className="hl-icon-bar" />}
    </svg>
  );
}

export const IconHighlights = (p: SVGProps<SVGSVGElement>) => <IconHighlighter {...p} />;
