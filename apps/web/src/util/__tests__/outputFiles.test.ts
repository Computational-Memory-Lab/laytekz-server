import { describe, it, expect } from 'vitest';
import { downloadName, outputDirOf, outputFileName, outputSibling } from '../outputFiles';

const pdf = '/aldine/api/projects/p1/output?branch=rev%2F2&path=paper%2F.aldine-out%2Fmain.pdf&t=42';

describe('outputSibling', () => {
  it('names the file beside the PDF on the same route, branch and base path, without the PDF’s cache-buster', () => {
    const bbl = outputSibling(pdf, '.bbl')!;
    expect(bbl.name).toBe('main.bbl');
    const u = new URL(bbl.url, 'http://x');
    expect(u.pathname).toBe('/aldine/api/projects/p1/output');
    expect(u.searchParams.get('branch')).toBe('rev/2');
    expect(u.searchParams.get('path')).toBe('paper/.aldine-out/main.bbl');
    expect(u.searchParams.has('t')).toBe(false);
  });

  it('has nothing to offer for a link that names no PDF', () => {
    expect(outputSibling('/api/projects/p1/output?path=.aldine-out%2Fmain.log', '.bbl')).toBeNull();
    expect(outputSibling('/api/projects/p1/archive?branch=main', '.bbl')).toBeNull();
  });
});

describe('outputFileName', () => {
  it('is the last segment of the served path', () => {
    expect(outputFileName(pdf)).toBe('main.pdf');
    expect(outputFileName('/api/projects/p1/output?branch=main')).toBeNull();
  });
});

// Galley: V2 (WP34) download names follow the project.
describe('downloadName', () => {
  it('names the file after the project, with the extension', () => {
    expect(downloadName('My paper', 'pdf')).toBe('My paper.pdf');
    expect(downloadName('My paper (arXiv)', '.zip')).toBe('My paper (arXiv).zip');
    expect(downloadName('Ünïcode – thesis', 'pdf')).toBe('Ünïcode – thesis.pdf');
  });

  it('replaces characters no file system takes, as V1 did', () => {
    expect(downloadName('My: Paper?', 'pdf')).toBe('My- Paper-.pdf');
    expect(downloadName('a/b\\c*d"e<f>g|h', 'pdf')).toBe('a-b-c-d-e-f-g-h.pdf');
    expect(downloadName('tab\there', 'pdf')).toBe('tabhere.pdf');
  });

  it('falls back to "document" for an empty name', () => {
    expect(downloadName('', 'pdf')).toBe('document.pdf');
    expect(downloadName(null, 'pdf')).toBe('document.pdf');
    expect(downloadName('   ', 'zip')).toBe('document.zip');
    expect(downloadName('...', 'zip')).toBe('document.zip');
  });

  it('drops trailing dots and spaces, and keeps Windows device names usable', () => {
    expect(downloadName('Draft. ', 'pdf')).toBe('Draft.pdf');
    expect(downloadName('CON', 'pdf')).toBe('CON_.pdf');
    expect(downloadName('lpt1', 'zip')).toBe('lpt1_.zip');
    expect(downloadName('Console', 'pdf')).toBe('Console.pdf');
  });
});

describe('outputDirOf', () => {
  it('is the folder the typeset wrote into', () => {
    expect(outputDirOf(pdf)).toBe('paper/.aldine-out');
    expect(outputDirOf('/api/projects/p1/output?branch=main&path=.aldine-out%2Fmain.pdf')).toBe('.aldine-out');
    expect(outputDirOf('/api/projects/p1/output?path=main.pdf')).toBe('');
    expect(outputDirOf('/api/projects/p1/output?branch=main')).toBeNull();
  });
});
