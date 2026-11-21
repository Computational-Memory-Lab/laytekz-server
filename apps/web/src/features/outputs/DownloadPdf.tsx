import { IconDownload } from '../../components/Icons';
import { downloadName } from '../../util/outputFiles';
import { usePageEvents } from '../host';
import type { SlotProps } from '../../slots/types';

/** The PDF pane's download button, as V1's editor page drew it; the file is named after the project. */
export default function DownloadPdf({ page }: SlotProps) {
  usePageEvents(page, ['compileFinished', 'projectChanged']);
  const pdfUrl = page?.lastCompile()?.pdfUrl;
  if (pdfUrl) {
    return (
      <a className="btn btn--ghost btn--small pdf-download" href={pdfUrl} download={downloadName(page?.project()?.name, 'pdf')} title="Download the PDF" aria-label="Download the PDF" data-testid="pdf-download"><IconDownload /></a>
    );
  }
  return (
    <button className="btn btn--ghost btn--small pdf-download" disabled title="Typeset the document first to download its PDF" aria-label="Download the PDF" data-testid="pdf-download"><IconDownload /></button>
  );
}
