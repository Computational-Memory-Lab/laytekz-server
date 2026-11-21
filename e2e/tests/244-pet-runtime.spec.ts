import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createPaperProject, createProject, openProject, typeset, cleanup } from './helpers';

/**
 * The roaming desk pet (WP44 pet-runtime, PET2). The suite's server has
 * ALDINE_INSTANCE_PET set to e2e/fixtures/operator/pet-test.png (a grey test
 * shape) and no accounts, so the pet is offered to everyone here; it has no
 * recorded squeak, so the squeak is synthesized. The screenshots swap in the
 * bundled pet image so they show what people see.
 */

type PetState = { state: string; surface: string | null; x: number; y: number; face: number; squeaks: number; w: number; h: number };
const BUNDLED_PET = path.resolve(__dirname, '../../apps/server/assets/pet/pet.png');

async function petState(page: Page): Promise<PetState> {
  return page.evaluate(() => (window as unknown as { __laytekzDeskPet: { state(): PetState } }).__laytekzDeskPet.state());
}

async function hook<T>(page: Page, call: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(([c, a]) => (window as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__laytekzDeskPet[c as string](...(a as unknown[])), [call, args] as const) as Promise<T>;
}

const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Counts AudioContexts and the oscillators and buffer sources started on them. */
function spyOnAudio() {
  const w = window as unknown as { AudioContext: typeof AudioContext; __audio: { contexts: number; oscillators: number; sources: number } };
  const Orig = w.AudioContext;
  w.__audio = { contexts: 0, oscillators: 0, sources: 0 };
  if (!Orig) return;
  w.AudioContext = class extends Orig {
    constructor(o?: AudioContextOptions) { super(o); w.__audio.contexts++; }
    createOscillator() { w.__audio.oscillators++; return super.createOscillator(); }
    createBufferSource() { w.__audio.sources++; return super.createBufferSource(); }
  } as typeof AudioContext;
}

test.describe('desk pet', () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test('off by default; turned on, it drops onto the editor bar; the menu and settings work', async ({ page, request }) => {
    const id = await createProject(request, 'Desk Pet');
    try {
      await openProject(page, id);
      await page.waitForTimeout(1500);
      await expect(page.getByTestId('desk-pet')).toHaveCount(0);

      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('turn the desk pet on');
      await page.keyboard.press('Enter');

      const pet = page.getByTestId('desk-pet');
      await expect(pet).toHaveAttribute('aria-hidden', 'true');
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
      await expect(pet).toHaveAttribute('data-surface', 'ledge:editor');

      // Small, standing on the editor bar's bottom line, clear of the file name.
      const body = (await page.getByTestId('desk-pet-body').boundingBox())!;
      expect(body.height).toBe(40);
      const header = (await page.locator('.pane--editor .pane__header').boundingBox())!;
      expect(Math.abs(body.y + body.height - (header.y + header.height - 1))).toBeLessThan(1.5);
      const name = (await page.getByTestId('active-file').boundingBox())!;
      expect(body.x).toBeGreaterThan(name.x + name.width);
      // Only the pet takes the pointer: the overlay lets clicks through.
      expect(await pet.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

      // The right-click menu; "Hide for an hour" sends it away with a toast.
      await page.getByTestId('desk-pet-body').click({ button: 'right' });
      await expect(page.getByTestId('desk-pet-menu')).toBeVisible();
      await expect(page.getByTestId('desk-pet-menu-squeak')).toBeVisible();
      await page.getByTestId('desk-pet-menu-away').click();
      await expect(page.getByText(/The desk pet is away until/)).toBeVisible();
      await expect(pet).toBeHidden({ timeout: 5_000 });

      await page.getByTestId('palette-open').click();
      await page.getByTestId('palette-input').fill('bring the desk pet back');
      await page.keyboard.press('Enter');
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });

      await page.goto(`/p/${id}/settings/pet`);
      await expect(page.getByTestId('settings-nav-pet')).toBeVisible();
      await expect(page.getByTestId('setting-pet.on')).toBeVisible();
      await expect(page.getByTestId('setting-pet.squeak')).toBeVisible();
      await expect(page.getByTestId('setting-pet.squeak')).toContainText('Squeak when clicked');
      await expect(page.getByTestId('setting-pet.perch')).toHaveCount(0);
    } finally {
      await cleanup(request, id);
    }
  });

  test('rides a PDF page as it scrolls, squeaks when clicked, and falls where it is dropped', async ({ page, request }) => {
    const id = await createPaperProject(request, 'Desk Pet Ride');
    try {
      await page.addInitScript(() => {
        localStorage.setItem('aldine.pet.on', 'true');
        localStorage.setItem('aldine.e2e.pet', '1');
      });
      await page.addInitScript(spyOnAudio);
      await page.route('**/api/instance/pet?v=*', (route) => route.fulfill({ path: BUNDLED_PET, contentType: 'image/png' }));
      await openProject(page, id);
      const pet = page.getByTestId('desk-pet');
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
      await hook(page, 'freeze', true);

      // Perched in the source, it stands in the white space: no text under it.
      if (await hook<boolean>(page, 'perch', 'code', 3)) {
        await expect(pet).toHaveAttribute('data-surface', /^code:/);
        const covered = await page.evaluate(() => {
          const pb = document.querySelector('[data-testid="desk-pet-body"]')!.getBoundingClientRect();
          const hits: string[] = [];
          for (const line of Array.from(document.querySelectorAll('.cm-content .cm-line'))) {
            const range = document.createRange();
            range.selectNodeContents(line);
            for (const r of Array.from(range.getClientRects())) {
              if (r.width > 0 && r.left < pb.right - 2 && r.right > pb.left + 2 && r.top < pb.bottom - 2 && r.bottom > pb.top + 2) hits.push(line.textContent ?? '');
            }
          }
          return hits;
        });
        expect(covered).toEqual([]);
        await page.screenshot({ path: test.info().outputPath('pet-on-code.png'), clip: { x: 230, y: 40, width: 620, height: 500 } });
      }

      await typeset(page);
      await expect.poll(() => page.locator('canvas.pdf-page').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual(2);
      await expect(page.locator('canvas.pdf-page[data-page="2"]')).toBeAttached();
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });

      // Page 2's top edge in the middle of the preview, then perch on it.
      await page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>('[data-testid="pdf-pane"]')!;
        const two = pane.querySelector<HTMLElement>('canvas.pdf-page[data-page="2"]')!;
        pane.scrollTop += two.getBoundingClientRect().top - pane.getBoundingClientRect().top - pane.clientHeight / 2;
      });
      await frames(page);
      expect(await hook<boolean>(page, 'perch', 'page', 0)).toBe(true);
      await expect(pet).toHaveAttribute('data-surface', 'page:2');
      const pageTop = () => page.locator('canvas.pdf-page[data-page="2"]').evaluate((c) => c.getBoundingClientRect().top);
      const before = (await page.getByTestId('desk-pet-body').boundingBox())!;
      expect(Math.abs(before.y + before.height - (await pageTop()))).toBeLessThan(1.5);
      await page.screenshot({ path: test.info().outputPath('pet-on-pdf-page.png') });

      // Scrolling the PDF carries it, pixel for pixel.
      await page.locator('[data-testid="pdf-pane"]').evaluate((el) => { el.scrollTop += 150; });
      await frames(page);
      const after = (await page.getByTestId('desk-pet-body').boundingBox())!;
      expect(after.y - before.y).toBeCloseTo(-150, 0);
      expect(after.x).toBeCloseTo(before.x, 0);
      expect(Math.abs(after.y + after.height - (await pageTop()))).toBeLessThan(1.5);

      // Click: a synthesized squeak (Web Audio oscillators) and a squash.
      await page.getByTestId('desk-pet-body').click();
      await expect(pet).toHaveAttribute('data-squeaks', '1');
      await expect(pet).toHaveAttribute('data-squeak', 'synth');
      await page.screenshot({ path: test.info().outputPath('pet-squeak.png'), clip: { x: after.x - 60, y: after.y - 60, width: after.width + 120, height: after.height + 90 } });
      const audio = await page.evaluate(() => (window as unknown as { __audio: { contexts: number; oscillators: number } }).__audio);
      expect(audio.contexts).toBe(1);
      expect(audio.oscillators).toBeGreaterThanOrEqual(4);
      await page.getByTestId('desk-pet-body').click();
      await expect(pet).toHaveAttribute('data-squeaks', '2');

      // A hop from the editor bar to the PDF page, slowed down to catch it in the air, above the toolbar's layer.
      await page.mouse.move(5, 450);
      expect(await pet.evaluate((el) => getComputedStyle(el).zIndex)).toBe('21');
      expect(await hook<boolean>(page, 'perch', 'ledge:editor')).toBe(true);
      const onBar = await petState(page);
      await hook(page, 'slow', 6);
      expect(await hook<boolean>(page, 'hop', 'page', 0)).toBe(true);
      await expect(pet).toHaveAttribute('data-state', 'hop');
      await page.waitForTimeout(1600);
      const midAir = await petState(page);
      await page.screenshot({ path: test.info().outputPath('pet-mid-hop.png') });
      expect(midAir.state).toBe('hop');
      expect(midAir.y).toBeLessThan(onBar.y);
      expect(midAir.x).toBeGreaterThan(onBar.x);
      await hook(page, 'slow', 1);
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 8_000 });
      await expect(pet).toHaveAttribute('data-surface', 'page:2');

      // Drag it from the editor bar over the editor and let go: it falls onto something below.
      await hook(page, 'perch', 'ledge:editor');
      const b = (await page.getByTestId('desk-pet-body').boundingBox())!;
      const editor = (await page.getByTestId('code-pane').boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(editor.x + editor.width / 2, editor.y + 120, { steps: 8 });
      await expect(pet).toHaveAttribute('data-state', 'drag');
      await page.mouse.up();
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 5_000 });
      await expect(pet).toHaveAttribute('data-surface', /^(code|floor|page|ledge)/);
      const landed = await petState(page);
      expect(landed.y).toBeGreaterThan(editor.y + 120);
    } finally {
      await cleanup(request, id);
    }
  });

  test('under reduced motion it sits still on one perch, and still squeaks and squashes', async ({ page, request }) => {
    const id = await createProject(request, 'Desk Pet Still');
    try {
      await page.addInitScript(() => {
        localStorage.setItem('aldine.pet.on', 'true');
        localStorage.setItem('aldine.pet.activity', '"playful"');
        localStorage.setItem('aldine.e2e.pet', '1');
      });
      await page.addInitScript(spyOnAudio);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openProject(page, id);
      const pet = page.getByTestId('desk-pet');
      await expect(pet).toHaveAttribute('data-state', 'idle', { timeout: 10_000 });
      await expect(pet).toHaveAttribute('data-reduced', 'true');
      await expect(pet).toHaveAttribute('data-surface', 'ledge:editor');
      const start = (await page.getByTestId('desk-pet-body').boundingBox())!;

      // A flick right past it, then a long wait: nothing moves.
      await page.mouse.move(start.x - 200, start.y + 10);
      await page.mouse.move(start.x + 250, start.y + 10, { steps: 3 });
      await page.waitForTimeout(3500);
      const still = (await page.getByTestId('desk-pet-body').boundingBox())!;
      expect(still).toEqual(start);
      await expect(pet).toHaveAttribute('data-state', 'idle');

      await page.getByTestId('desk-pet-body').click();
      await expect(pet).toHaveAttribute('data-squeaks', '1');
      const squash = await page.locator('.desk-pet__fx').evaluate((el) => el.getAnimations().length);
      expect(squash).toBe(1);
      await page.waitForTimeout(800);
      expect((await page.getByTestId('desk-pet-body').boundingBox())!).toEqual(start);
      await expect(pet).toHaveAttribute('data-state', 'idle');
    } finally {
      await cleanup(request, id);
    }
  });
});
