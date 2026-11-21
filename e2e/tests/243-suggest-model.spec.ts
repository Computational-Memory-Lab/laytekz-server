import { test, expect } from '../fixtures';

/**
 * WP43 smarter suggestions (feature 12): the experimental model row is off by
 * default and says what it downloads and that nothing typed leaves the
 * computer. Turning it on downloads the pinned file from Hugging Face; here
 * the host is faked, so the checksum check fails, nothing is kept, and the
 * switch turns back off. Cancel stops a download in progress.
 */
test.use({ settingsTestDefaults: null });

const MODEL_URL = /^https:\/\/huggingface\.co\/ibm-granite\/granite-4\.0-350m-base-GGUF\/resolve\/b2628819fb4e3ee4a42988e532483124b3366bd2\/granite-4\.0-350m-base-Q4_K_M\.gguf$/;

test.describe('smarter suggestions (experimental)', () => {
  test('off by default; a download that fails its checksum keeps nothing', async ({ page }) => {
    const asked: string[] = [];
    await page.route('https://huggingface.co/**', async (route) => {
      asked.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: Buffer.alloc(4096, 7) });
    });
    await page.goto('/settings/completion');
    const row = page.getByTestId('setting-suggest.model');
    await expect(row).toContainText('Smarter suggestions (experimental)');
    await expect(row).toContainText('237 MB');
    await expect(row).toContainText('nothing you type leaves it');
    const sw = page.getByTestId('suggest-model-switch');
    await expect(sw).not.toBeChecked();
    await expect(page.getByTestId('suggest-model-status')).toContainText('Not downloaded');
    expect(asked).toEqual([]);

    await sw.click();
    await expect(page.getByTestId('suggest-model-status')).toContainText('did not match its checksum');
    await expect(sw).not.toBeChecked();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(MODEL_URL);
    expect(await page.evaluate(async () => (await (await caches.open('laytekz-suggest-model')).keys()).length)).toBe(0);
    await expect(page.getByTestId('suggest-model-retry')).toBeVisible();
  });

  test('cancel stops a download in progress', async ({ page }) => {
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    await page.route('https://huggingface.co/**', async (route) => {
      await hold;
      await route.abort().catch(() => {});
    });
    await page.goto('/settings/completion');
    const sw = page.getByTestId('suggest-model-switch');
    await expect(page.getByTestId('suggest-model-status')).toContainText('Not downloaded');
    await sw.click();
    await expect(page.getByTestId('suggest-model-status')).toContainText('Downloading 0%');
    await expect(page.getByTestId('suggest-model-progress')).toBeVisible();
    await page.getByTestId('suggest-model-cancel').click();
    await expect(page.getByTestId('suggest-model-status')).toContainText('Not downloaded');
    await expect(sw).not.toBeChecked();
    release();
  });
});
