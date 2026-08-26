import { expect, test } from '@playwright/test';

test('public entry is a registry command centre, themeable and links to the reviewer guide', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'MCA21 Corporate Services' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Corporate filings, company records and transaction status—in one clear workspace.' })).toBeVisible();
  await expect(page.getByPlaceholder('Search services, forms, companies or transaction references')).toBeVisible();
  await page.getByRole('button', { name: /Accessibility · Dark mode/i }).click();
  await expect(page.getByRole('button', { name: /Accessibility · Light mode/i })).toBeVisible();
  await page.getByRole('button', { name: 'Reviewer Guide' }).first().click();
  await expect(page).toHaveURL(/\/reviewer$/);
  await expect(page.getByRole('heading', { name: 'Five recovery paths. Five minutes.' })).toBeVisible();
  await expect(page.locator('.reviewer-links a')).toHaveCount(5);
});

test('first viewport exposes context, services, data and sample access', async ({ page }, testInfo) => {
  await page.goto('/login');
  if (testInfo.project.name === 'desktop-chromium') {
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(page.getByText('Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs')).toBeVisible();
    await expect(page.locator('.quick-actions button')).toHaveCount(8);
    for (const button of await page.locator('.quick-actions button').all()) {
      const box = await button.boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(768);
    }
    const access = await page.getByRole('button', { name: /Open sample company workspace/i }).boundingBox();
    const data = await page.getByText('All demo systems operational').boundingBox();
    expect(access && access.y + access.height).toBeLessThanOrEqual(768);
    expect(data && data.y + data.height).toBeLessThanOrEqual(768);
  } else {
    for (const label of ['File annual accounts', 'Register a company', 'Register an LLP', 'Update director details']) {
      await expect(page.getByRole('button', { name: new RegExp(label, 'i') })).toBeVisible();
    }
    const access = await page.getByRole('button', { name: /Open sample company workspace/i }).boundingBox();
    expect(access && access.y + access.height).toBeLessThanOrEqual(800);
  }
  await expect(page.locator('.registry-home img')).toHaveCount(0);
});

test('public service directory can be browsed without signing in', async ({ page }) => {
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Start with the task, not the portal map.' })).toBeVisible();
  await page.getByLabel('Search the catalogue').fill('certified copy');
  await expect(page.getByText(/matching services/i)).toBeVisible();
});

test('public headers stay consistent and dark surfaces remain readable', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Visual-system comparison runs once.');
  const buttonStyle = async () => page.locator('.registry-utilities').getByRole('button', { name: 'Reviewer Guide', exact: true }).evaluate((element) => {
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    return { height: Math.round(box.height), color: style.color, background: style.backgroundColor, borderRadius: style.borderRadius, whiteSpace: style.whiteSpace, fontSize: style.fontSize };
  });
  await page.goto('/login');
  await expect(page.locator('.registry-utilities').getByRole('button', { name: 'Reviewer Guide', exact: true })).toBeVisible();
  const homeButton = await buttonStyle();
  await page.goto('/services');
  await expect(page.locator('.registry-utilities').getByRole('button', { name: 'Reviewer Guide', exact: true })).toBeVisible();
  await page.waitForTimeout(150);
  expect(await buttonStyle()).toEqual(homeButton);
  expect(homeButton.whiteSpace).toBe('nowrap');

  await page.getByRole('button', { name: /Accessibility · Dark mode/i }).click();
  const surfaces = await page.locator('.directory-search, .directory-filter, .catalogue-loading, .category-grid article').evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  }));
  expect(surfaces.length).toBeGreaterThan(2);
  expect(new Set(surfaces.map((surface) => surface.background))).toEqual(new Set(['rgb(18, 29, 35)']));
  expect(new Set(surfaces.map((surface) => surface.color))).toEqual(new Set(['rgb(241, 245, 242)']));
  await expect(page.locator('.registry-footer')).toHaveCSS('background-color', 'rgb(17, 24, 32)');
});

test('a new MGT-7 guided intake persists in the filing register', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
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
