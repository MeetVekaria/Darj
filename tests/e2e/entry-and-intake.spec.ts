import { expect, test } from '@playwright/test';

test('public entry is a registry command centre, themeable and links to the reviewer guide', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'MCA21 Corporate Services' })).toBeVisible();
  if ((await page.viewportSize())!.width > 760) await expect(page.getByText('CORPORATE FILING SERVICES')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'File company forms, view records and track transactions' })).toBeVisible();
  await expect(page.getByPlaceholder('Search services, forms, companies or transaction references')).toBeVisible();
  await page.getByRole('button', { name: /Accessibility · Dark mode/i }).click();
  await expect(page.getByRole('button', { name: /Accessibility · Light mode/i })).toBeVisible();
  await page.getByRole('button', { name: 'Reviewer Guide' }).first().click();
  await expect(page).toHaveURL(/\/reviewer$/);
  await expect(page.getByRole('heading', { name: 'One guided filing and five recovery proofs' })).toBeVisible();
  await expect(page.locator('.reviewer-feature')).toContainText('Prepare AOC-4 from documents');
  await expect(page.locator('.reviewer-links a')).toHaveCount(5);
});

test('light is the default and dark mode requires an explicit choice', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: /Accessibility · Dark mode/i })).toBeVisible();

  await page.getByRole('button', { name: /Accessibility · Dark mode/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /Accessibility · Light mode/i }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('a clean public visit does not probe the authenticated API', async ({ page }) => {
  const calls: string[] = [];
  await page.addInitScript(() => window.localStorage.setItem('darj-session-active', 'true'));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/darj') calls.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'File company forms, view records and track transactions' })).toBeVisible();
  await page.waitForTimeout(250);
  expect(calls).toEqual([]);
});

test('first viewport exposes context, services, data and sample access', async ({ page }, testInfo) => {
  await page.goto('/login');
  if (testInfo.project.name === 'desktop-chromium') {
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect(page.getByText('Synthetic data · Independent prototype · Not affiliated with the Ministry of Corporate Affairs')).toBeVisible();
    await expect(page.locator('.quick-actions button')).toHaveCount(8);
    const headline = await page.locator('.command-main h2').evaluate((element) => {
      const style = getComputedStyle(element);
      return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight };
    });
    expect(headline.size).toBeLessThanOrEqual(32);
    expect(headline.weight).toBe('500');
    const servicesHeading = await page.locator('.home-section-heading h2').first().evaluate((element) => {
      const style = getComputedStyle(element);
      return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight };
    });
    expect(servicesHeading.size).toBeLessThanOrEqual(32);
    expect(servicesHeading.weight).toBe('500');
    for (const button of await page.locator('.quick-actions button').all()) {
      const box = await button.boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(768);
    }
    const access = await page.getByRole('button', { name: /Open sample company workspace/i }).boundingBox();
    const data = await page.getByText('All demo systems operational').boundingBox();
    expect(access && access.y + access.height).toBeLessThanOrEqual(768);
    expect(data && data.y + data.height).toBeLessThanOrEqual(768);
  } else {
    for (const label of ['Prepare an MCA filing from documents', 'Register a company', 'Register an LLP', 'Update director details']) {
      await expect(page.getByRole('button', { name: new RegExp(label, 'i') })).toBeVisible();
    }
    const access = await page.getByRole('button', { name: /Open sample company workspace/i }).boundingBox();
    expect(access && access.y + access.height).toBeLessThanOrEqual(800);
  }
  await expect(page.locator('.registry-home img')).toHaveCount(0);
});

test('public service directory can be browsed without signing in', async ({ page }) => {
  await page.goto('/services');
  await expect(page.getByRole('heading', { name: 'Find an MCA form or service' })).toBeVisible();
  const heading = await page.locator('.directory-hero h1').evaluate((element) => {
    const style = getComputedStyle(element);
    return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight };
  });
  expect(heading.size).toBeLessThanOrEqual(36);
  expect(heading.weight).toBe('500');
  await page.getByLabel('Search the catalogue').fill('certified copy');
  await expect(page.getByText(/matching services/i)).toBeVisible();
});

test('workspace masthead, side navigation and form anchors remain clear while scrolling', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop sticky geometry runs once.');
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await expect(page).toHaveURL(/\/filings$/);

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const geometry = await page.evaluate(() => {
    const header = document.querySelector<HTMLElement>('.app-header')!;
    const strip = document.querySelector<HTMLElement>('.prototype-strip')!;
    const nav = document.querySelector<HTMLElement>('.platform-nav')!;
    const first = nav.querySelector<HTMLElement>('nav button:first-child')!;
    const last = nav.querySelector<HTMLElement>('nav button:last-child')!;
    const footer = document.querySelector<HTMLElement>('.app-footer')!;
    const headerBox = header.getBoundingClientRect();
    const navBox = nav.getBoundingClientRect();
    return {
      headerBottom: Math.round(headerBox.bottom),
      headerTop: Math.round(headerBox.top),
      headerBackground: getComputedStyle(header).backgroundColor,
      stripBottom: Math.round(strip.getBoundingClientRect().bottom),
      navTop: Math.round(navBox.top),
      navBottom: Math.round(navBox.bottom),
      firstTop: Math.round(first.getBoundingClientRect().top),
      lastBottom: Math.round(last.getBoundingClientRect().bottom),
      footerLeft: Math.round(footer.getBoundingClientRect().left),
      viewportHeight: window.innerHeight,
    };
  });
  expect(geometry.headerBackground).not.toContain('rgba');
  expect(geometry.stripBottom).toBe(geometry.headerTop);
  expect(geometry.navTop).toBeGreaterThanOrEqual(geometry.headerBottom);
  expect(geometry.navBottom).toBeLessThanOrEqual(geometry.viewportHeight);
  expect(geometry.firstTop).toBeGreaterThanOrEqual(geometry.navTop);
  expect(geometry.lastBottom).toBeLessThanOrEqual(geometry.navBottom);
  expect(geometry.footerLeft).toBeGreaterThanOrEqual(224);

  await page.getByRole('button', { name: /Continue filing|View record/i }).first().click();
  await page.locator('.section-index a[href="#attachments"]').click();
  await expect(page.locator('#attachments')).toBeInViewport();
  await expect(page.locator('.section-index a[href="#attachments"]')).toHaveAttribute('aria-current', 'location');
  await expect(page.locator('.section-index a[href="#company"]')).not.toHaveClass(/active/);
  const targetTop = await page.locator('#attachments').evaluate((element) => Math.round(element.getBoundingClientRect().top));
  const headerBottom = await page.locator('.app-header').evaluate((element) => Math.round(element.getBoundingClientRect().bottom));
  expect(targetTop).toBeGreaterThanOrEqual(headerBottom + 8);
});

test('protected route restoration never flashes the public login screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Restoration timing runs once.');
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await expect(page).toHaveURL(/\/filings$/);
  await page.route('**/api/darj', async (route) => {
    if (route.request().method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    await route.continue();
  });
  const navigation = page.goto('/filings/DARJ-DEMO-AOC4-01/prepare');
  await expect(page.getByText('Restoring secure workspace')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'File company forms, view records and track transactions' })).toHaveCount(0);
  await navigation;
  await expect(page.getByRole('heading', { name: 'Prepare AOC-4' })).toBeVisible();
});

test('Guided Filing Studio creates a source-linked reviewed draft', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await page.getByRole('button', { name: /Guided filing/i }).click();
  await expect(page).toHaveURL(/\/studio$/);
  await page.getByRole('button', { name: 'Open prepared package' }).click();
  await expect(page.getByRole('heading', { name: 'No source evidence means no silent autofill' })).toBeVisible();
  await expect(page.locator('.field-register > button')).toHaveCount(10);
  await page.getByRole('button', { name: 'Complete professional review' }).click();
  const errorToast = page.locator('.error-toast');
  await expect(errorToast).toContainText('DARJ_STUDIO_BLOCKED');
  await expect(errorToast).toBeInViewport();
  await expect(errorToast).toBeFocused();
  await errorToast.getByRole('button', { name: 'Dismiss message' }).click();
  await page.getByRole('button', { name: 'Evidence Mode on' }).click();
  await expect(page.getByText('Evidence details are hidden')).toBeVisible();
  await page.getByRole('button', { name: 'Evidence Mode off' }).click();
  await expect(page.locator('.source-evidence blockquote')).toBeVisible();
  await page.getByLabel('Review role').selectOption('CA/CS/CMA reviewer');
  await page.getByRole('button', { name: 'Accept extraction' }).click();
  await expect(page.locator('.review-decision')).toContainText('ACCEPTED');
  await page.getByRole('button', { name: 'Complete professional review' }).click();
  await expect(page.getByRole('button', { name: /Create reviewed draft/i })).toBeEnabled();
  const preview = await page.evaluate(async () => {
    const response = await fetch('/api/darj?export=preview');
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, header: new TextDecoder().decode(bytes.slice(0, 5)), type: response.headers.get('content-type') };
  });
  expect(preview).toEqual({ status: 200, header: '%PDF-', type: 'application/pdf' });
  await page.getByRole('button', { name: /Create reviewed draft/i }).click();
  await expect(page.getByRole('heading', { name: 'Prepare AOC-4' })).toBeVisible();
  await expect(page.getByLabel('Board meetings')).toHaveValue('4');
});

test('plain language filing finder returns a visible match and meaningful destination', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await page.getByRole('button', { name: /Guided filing/i }).click();
  await page.getByLabel('Plain language filing need').fill('I need to complete my annual return');
  await page.getByRole('button', { name: 'Find the filing' }).click();
  const result = page.locator('.service-finder-result');
  await expect(result).toContainText('MGT-7 · Annual return');
  await result.getByRole('button', { name: 'Open in service catalogue' }).click();
  await expect(page).toHaveURL(/\/services$/);
  await expect(page.getByLabel('Search the catalogue')).toHaveValue('MGT-7');
});

test('Guided Filing Studio blocks and explicitly resolves conflicting evidence', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await page.getByRole('button', { name: /Guided filing/i }).click();
  await page.getByRole('radio', { name: 'Conflicting AGM date' }).check();
  await page.getByRole('button', { name: 'Open prepared package' }).click();
  await expect(page.getByText(/different AGM dates/i).first()).toBeVisible();
  await expect(page.getByText(/BLOCKING/).first()).toBeVisible();
  await page.getByRole('button', { name: /Use Board’s Report/i }).click();
  await page.getByLabel('Review role').selectOption('CA/CS/CMA reviewer');
  await page.locator('.field-register > button').filter({ hasText: 'AGM date' }).click();
  await page.getByRole('button', { name: 'Accept extraction' }).click();
  await expect(page.getByRole('button', { name: 'Complete professional review' })).toBeEnabled();
  await page.getByRole('button', { name: 'Complete professional review' }).click();
  await expect(page.getByRole('button', { name: /Create reviewed draft/i })).toBeEnabled();
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
  await expect.poll(buttonStyle).toEqual(homeButton);
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
