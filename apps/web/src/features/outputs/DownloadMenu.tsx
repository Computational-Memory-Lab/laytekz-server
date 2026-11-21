import { IconChevronDown } from '../../components/Icons';
import { MenuButton, type MenuEntry } from '../../components/Menu';
import { api } from '../../api';
import { downloadName } from '../../util/outputFiles';
import { usePageEvents } from '../host';
import type { SlotProps } from '../../slots/types';
import { downloadForArxiv, saveLink } from './api';
import './outputs.css';

/**
 * F11/F10 (WP34): the Download menu beside the PDF download button: the PDF,
 * the source as a ZIP, and a ZIP for arXiv. Every download is named after the project.
 */
export default function DownloadMenu({ page }: SlotProps) {
  usePageEvents(page, ['compileFinished', 'projectChanged']);
  if (!page) return null;
  const items = (): MenuEntry[] => {
    const pdfUrl = page.lastCompile()?.pdfUrl ?? null;
    const name = page.project()?.name;
    return [
      { id: 'pdf', label: 'PDF', disabled: !pdfUrl, testId: 'download-menu-pdf', onSelect: () => { if (pdfUrl) saveLink(pdfUrl, downloadName(name, 'pdf')); } },
      { id: 'zip', label: 'Source as ZIP', testId: 'download-menu-zip', onSelect: () => saveLink(api.archiveUrl(page.projectId, page.branch), downloadName(name, 'zip')) },
      { id: 'arxiv', label: 'For arXiv (ZIP with the .bbl)', testId: 'download-menu-arxiv', onSelect: () => { void downloadForArxiv({ projectId: page.projectId, branch: page.branch, projectName: name, toast: page.toast, confirm: page.confirm, page }); } },
    ];
  };
  return (
    <MenuButton items={items} label="Download" className="btn btn--ghost btn--small pdf-download-menu" testId="pdf-download-menu" menuTestId="download-menu"
      placement="bottom-end" title="More downloads: the source, a ZIP for arXiv" ariaLabel="More downloads" sheetTitle="Download">
      <IconChevronDown />
    </MenuButton>
  );
}
