import { lazy } from 'react';
import type { CommandDef } from '../../commands/types';
import type { EditorPageCtx, FeatureModule } from '../types';
import { downloadName } from '../../util/outputFiles';
import { getSetting, setSetting } from '../../settings/store';
import DownloadPdf from './DownloadPdf';
import DownloadMenu from './DownloadMenu';
import { downloadForArxiv, saveLink, trackPage } from './api';
import { LIST_SETTING } from './ids';

const GeneratedFiles = lazy(() => import('./GeneratedFiles'));

function commands(page: EditorPageCtx): CommandDef[] {
  const name = () => page.project()?.name;
  return [
    {
      id: 'outputs.downloadPdf',
      title: 'Download the PDF',
      group: 'Project',
      keywords: 'pdf save export download',
      when: (p) => !!p.lastCompile()?.pdfUrl,
      run: () => { const url = page.lastCompile()?.pdfUrl; if (url) saveLink(url, downloadName(name(), 'pdf')); },
    },
    {
      id: 'outputs.downloadArxiv',
      title: 'Download for arXiv (ZIP with the .bbl)',
      group: 'Project',
      keywords: 'arxiv submission submit zip bbl export journal',
      run: () => { void downloadForArxiv({ projectId: page.projectId, branch: page.branch, projectName: name(), toast: page.toast, confirm: page.confirm, page }); },
    },
    {
      id: 'outputs.showGenerated',
      title: 'Show the generated files',
      group: 'Project',
      keywords: 'bbl log aux output generated extra files',
      when: () => getSetting<boolean>(LIST_SETTING) === false,
      run: () => { setSetting(LIST_SETTING, true); page.toast('The generated files are listed under the file tree.', 'ok'); },
    },
  ];
}

/**
 * F11 generated files and downloads, plus F10's download names (WP34): the
 * PDF download button and its Download menu (PDF, source ZIP, arXiv ZIP) in
 * the PDF header, and the generated-files list under the file tree.
 */
const feature: FeatureModule = {
  id: 'outputs',
  slots: [
    { id: 'outputs.download', slot: 'pdf.actions', order: 900, render: DownloadPdf },
    { id: 'outputs.downloadMenu', slot: 'pdf.actions', order: 910, render: DownloadMenu },
    { id: 'outputs.generated', slot: 'files.footer', order: 100, render: GeneratedFiles },
  ],
  commands,
  activate: (page) => trackPage(page),
};

export default feature;
