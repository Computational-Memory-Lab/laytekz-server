import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppCtx, EditorPageCtx } from '../types';
import type { CompileResult, TreeEntry } from '../../api';

const { createEmitter } = await import('../events');
const { default: outputsFeature } = await import('../outputs');
const { default: DownloadPdf } = await import('../outputs/DownloadPdf');
const { IconDownload } = await import('../../components/Icons');

const app = {} as AppCtx;

function page(o: { file?: string | null; files?: TreeEntry[]; result?: Partial<CompileResult> | null; name?: string; id?: string } = {}): EditorPageCtx {
  return {
    projectId: o.id ?? 'p1',
    branch: 'main',
    events: createEmitter(),
    activeFile: () => (o.file === undefined ? 'main.tex' : o.file),
    files: () => o.files ?? [],
    lastCompile: () => (o.result ?? null) as CompileResult | null,
    project: () => ({ name: o.name ?? 'My: Paper?' }),
  } as unknown as EditorPageCtx;
}

describe('interim download button (features/outputs)', () => {
  const slot = outputsFeature.slots![0];
  /** V1's two buttons, copied from Editor.tsx. */
  const v1 = (pdfUrl: string | null, name: string) => renderToStaticMarkup(pdfUrl
    ? createElement('a', { className: 'btn btn--ghost btn--small pdf-download', href: pdfUrl, download: `${(name || 'document').replace(/[\\/:*?"<>|]/g, '-')}.pdf`, title: 'Download the PDF', 'aria-label': 'Download the PDF', 'data-testid': 'pdf-download' }, createElement(IconDownload))
    : createElement('button', { className: 'btn btn--ghost btn--small pdf-download', disabled: true, title: 'Typeset the document first to download its PDF', 'aria-label': 'Download the PDF', 'data-testid': 'pdf-download' }, createElement(IconDownload)));

  it('sits in pdf.actions at 900', () => {
    expect(slot.slot).toBe('pdf.actions');
    expect(slot.order).toBe(900);
  });

  it('draws exactly what V1 drew, before and after a typeset', () => {
    expect(renderToStaticMarkup(createElement(DownloadPdf, { page: page(), app }))).toBe(v1(null, 'My: Paper?'));
    const typeset = page({ result: { pdfUrl: '/api/projects/p1/pdf/main.pdf?run=3' } });
    expect(renderToStaticMarkup(createElement(DownloadPdf, { page: typeset, app }))).toBe(v1('/api/projects/p1/pdf/main.pdf?run=3', 'My: Paper?'));
    const unnamed = page({ result: { pdfUrl: '/x.pdf' }, name: '' });
    expect(renderToStaticMarkup(createElement(DownloadPdf, { page: unnamed, app }))).toBe(v1('/x.pdf', ''));
  });
});
