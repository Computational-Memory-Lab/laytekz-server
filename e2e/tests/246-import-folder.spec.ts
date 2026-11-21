import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Galley: importing a project from a folder (Home › New › Import a folder…).
test('a picked folder becomes a project, without its hidden and build files', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'laytekz-folder-'));
  const dir = path.join(tmp, 'Folder Thesis');
  fs.mkdirSync(path.join(dir, 'figures'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, 'main.tex'), '\\documentclass{article}\\begin{document}FOLDER-IMPORTED\\end{document}\n');
  fs.writeFileSync(path.join(dir, 'figures', 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'main.aux'), '\\relax');
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');

  await page.goto('/');
  await page.getByTestId('import-folder-input').setInputFiles(dir);
  await expect(page.getByTestId('editor-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.cm-content')).toContainText('FOLDER-IMPORTED');
  await page.getByTestId('source-only').click();
  await expect(page.getByTestId('dir-figures')).toBeVisible();
  await expect(page.getByTestId('file-main.aux')).toHaveCount(0);
  fs.rmSync(tmp, { recursive: true, force: true });
});
