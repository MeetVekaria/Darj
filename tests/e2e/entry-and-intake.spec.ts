import { expect, test } from '@playwright/test';

test('public entry is concise, themeable and links to the five-step reviewer guide', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'File with confidence. Keep proof of every step.' })).toBeVisible();
  await page.getByRole('button', { name: /Switch to dark mode/i }).click();
  await expect(page.getByRole('button', { name: /Switch to light mode/i })).toBeVisible();
  await page.getByRole('button', { name: 'Reviewer guide' }).first().click();
  await expect(page).toHaveURL(/\/reviewer$/);
  await expect(page.getByRole('heading', { name: 'Five recovery paths. Five minutes.' })).toBeVisible();
  await expect(page.locator('.reviewer-links a')).toHaveCount(5);
});

test('a new MGT-7 guided intake persists in the filing register', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Enter Meet’s filing/i }).click();
  await page.getByRole('button', { name: /Start a new filing/i }).click();
  await page.getByRole('radio', { name: /MGT-7 Annual return/i }).click();
  await page.getByLabel('Note optional').fill('Annual return checklist');
  await page.getByRole('button', { name: 'Create filing' }).click();
  await expect(page).toHaveURL(/\/filings$/);
  const row = page.locator('.filing-row').filter({ hasText: 'MGT-7' });
  await expect(row).toContainText('INTAKE SAVED');
  await page.reload();
  await expect(page.locator('.filing-row').filter({ hasText: 'MGT-7' })).toContainText('INTAKE SAVED');
});
