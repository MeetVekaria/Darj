import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: /Enter Meet’s filing/i }).click();
  await expect(page).toHaveURL(/\/filings$/);
  await expect(page.getByRole('heading', { name: /Two cases/i })).toBeVisible();
}

async function apiPost(page: Page, action: string, data: Record<string, unknown> = {}) {
  return page.evaluate(async ({ action: requestedAction, data: requestedData }) => {
    const csrf = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('darj_csrf='))?.split('=')[1] ?? '';
    const response = await fetch('/api/darj', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DARJ-CSRF': decodeURIComponent(csrf) },
      body: JSON.stringify({ action: requestedAction, ...requestedData }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { action, data });
}

async function openPrepare(page: Page) {
  await page.getByRole('button', { name: /Continue filing|View record/i }).first().click();
  await expect(page).toHaveURL(/\/prepare$/);
  await expect(page.getByRole('heading', { name: 'Prepare AOC-4' })).toBeVisible();
}

async function fixAndCheck(page: Page) {
  await page.getByLabel('Board meetings').fill('4');
  await expect(page.getByText('Saved locally · Synced').first()).toBeVisible();
  await page.getByRole('button', { name: /Run Jaanch/i }).click();
  await expect(page.getByRole('heading', { name: '43 checks · 43 passed · 0 needs attention' })).toBeVisible();
}

async function sealAndSign(page: Page) {
  await page.getByRole('button', { name: /Create Mohar/i }).click();
  await expect(page.getByRole('heading', { name: /immutable package is ready/i })).toBeVisible();
  await page.getByRole('button', { name: /Continue to demo signing/i }).click();
  await expect(page.getByText('SIGNED · VERIFIED')).toBeVisible();
  await expect(page.getByText('Ed25519 verification passed')).toBeVisible();
}

async function completeJourney(page: Page) {
  await login(page);
  await openPrepare(page);
  await fixAndCheck(page);
  await sealAndSign(page);
  await page.getByRole('button', { name: /Submit exact package/i }).click();
  await expect(page.getByRole('heading', { name: /exact package is in DARJ custody/i })).toBeVisible();
  await expect(page.getByText('DARJ-RASID-8129').first()).toBeVisible();
  await page.getByRole('button', { name: /Approve simulated payment/i }).click();
  await expect(page.getByText('PAID · RECONCILED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Track processing/i }).click();
  await page.getByRole('button', { name: 'Pause processor' }).click();
  await expect(page.getByRole('heading', { name: 'PROCESSING DELAYED' })).toBeVisible();
  await expect(page.getByText(/Do not resubmit or pay again/i)).toBeVisible();
  await page.getByRole('button', { name: /Resume and finish processing/i }).click();
  await expect(page.getByRole('heading', { name: 'ACCEPTED' })).toBeVisible();
}

test('P0 primary journey reaches ACCEPTED with response and callback recovery', async ({ page }) => {
  await completeJourney(page);
  await expect(page.getByText('RECEIVED ≠ PAID ≠ PROCESSING ≠ ACCEPTED')).toBeVisible();
});

test('two same-credential reviewer sessions remain isolated', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Isolation is browser-context behavior and runs once.');
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await Promise.all([login(pageA), login(pageB)]);
    const [stateA, stateB] = await Promise.all([
      pageA.evaluate(() => fetch('/api/darj').then((response) => response.json())),
      pageB.evaluate(() => fetch('/api/darj').then((response) => response.json())),
    ]) as [{ runId: string }, { runId: string }];
    expect(stateA.runId).not.toBe(stateB.runId);
    await Promise.all([openPrepare(pageA), openPrepare(pageB)]);
    await pageA.getByLabel('Board meetings').fill('5');
    await pageB.getByLabel('Board meetings').fill('6');
    await expect(pageA.getByText('Saved locally · Synced').first()).toBeVisible();
    await expect(pageB.getByText('Saved locally · Synced').first()).toBeVisible();
    const [afterA, afterB] = await Promise.all([
      pageA.evaluate(() => fetch('/api/darj').then((response) => response.json())),
      pageB.evaluate(() => fetch('/api/darj').then((response) => response.json())),
    ]) as [{ draft: { form: { boardMeetings: string } } }, { draft: { form: { boardMeetings: string } } }];
    expect(afterA.draft.form.boardMeetings).toBe('5');
    expect(afterB.draft.form.boardMeetings).toBe('6');
    await pageA.getByRole('button', { name: /Reset this demo run/i }).click();
    const untouchedB = await pageB.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { draft: { form: { boardMeetings: string } } };
    expect(untouchedB.draft.form.boardMeetings).toBe('6');
  } finally {
    await contextA.close(); await contextB.close();
  }
});

test('browser interruption restores IndexedDB draft before server sync', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Recovery behavior runs once.');
  await login(page); await openPrepare(page);
  await page.route('**/api/darj', async (route) => {
    if (route.request().method() === 'POST' && route.request().postData()?.includes('saveDraft')) await route.abort('internetdisconnected');
    else await route.continue();
  });
  await page.getByLabel('Board meetings').fill('7');
  await expect(page.getByText('Saved locally · Offline').first()).toBeVisible();
  await page.unroute('**/api/darj');
  const context = page.context();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto('/filings/DARJ-DEMO-AOC4-01/prepare');
  await expect(reopened.getByLabel('Board meetings')).toHaveValue('7');
  await expect(reopened.getByText('Saved locally · Synced').first()).toBeVisible();
});

test('stale server draft shows a field-level conflict and explicit choice', async ({ browser }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Conflict behavior runs once.');
  const context = await browser.newContext();
  const first = await context.newPage();
  const stale = await context.newPage();
  try {
    await login(first);
    await stale.goto('/filings');
    await expect(stale.getByRole('heading', { name: /Two cases/i })).toBeVisible();
    await Promise.all([openPrepare(first), openPrepare(stale)]);
    await first.getByLabel('Board meetings').fill('5');
    await expect(first.getByText('Saved locally · Synced').first()).toBeVisible();
    await stale.getByLabel('Board meetings').fill('6');
    await expect(stale.getByRole('heading', { name: /Choose which value/i })).toBeVisible();
    await expect(stale.getByText('Local').first()).toBeVisible();
    await expect(stale.getByText('Server').first()).toBeVisible();
    await stale.getByRole('button', { name: /Keep local as new version/i }).click();
    await expect(stale.getByText('Saved locally · Synced').first()).toBeVisible();
  } finally { await context.close(); }
});

test('session expiry preserves and resumes the local draft', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Session recovery runs once.');
  await login(page); await openPrepare(page);
  await page.getByLabel('Board meetings').fill('5');
  await expect(page.getByText('Saved locally · Synced').first()).toBeVisible();
  await page.evaluate(async () => {
    const csrf = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('darj_csrf='))?.split('=')[1] ?? '';
    await fetch('/api/darj', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DARJ-CSRF': decodeURIComponent(csrf) }, body: JSON.stringify({ action: 'setRecovery', flag: 'expire_session' }) });
  });
  await page.reload();
  await expect(page.getByText('Local work is safe')).toBeVisible();
  await page.getByRole('button', { name: /Enter Meet’s filing/i }).click();
  await expect(page).toHaveURL(/\/prepare$/);
  await expect(page.getByLabel('Board meetings')).toHaveValue('5');
});

test('P0 upload verifies stored PDF and edit after signing creates v24', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Upload and mutation behavior run once.');
  await login(page); await openPrepare(page);
  const boardRow = page.locator('.attachment-row').filter({ hasText: 'Board report' });
  await boardRow.locator('input[type=file]').setInputFiles({ name: 'DARJ-replacement-board-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% DARJ demo replacement\n%%EOF') });
  await expect(page.getByText(/TUS complete.*MIME, bytes and SHA-256 verified/i)).toBeVisible();
  await fixAndCheck(page); await sealAndSign(page);
  await page.getByRole('button', { name: /Edit as new version/i }).click();
  await page.getByLabel('Revenue (₹)').fill('124800001');
  await expect(page.getByText('SIGNATURE INVALID · NEW VERSION REQUIRED')).toBeVisible();
  await page.getByRole('button', { name: /Run Jaanch/i }).click();
  await page.getByRole('button', { name: /Create Mohar/i }).click();
  await expect(page.getByText('DARJ-PKG-000024 · v24')).toBeVisible();
  await page.getByRole('button', { name: /Continue to demo signing/i }).click();
  await expect(page.getByText('SIGNED · VERIFIED')).toBeVisible();
});

test('atomic custody rollback, serialization retry, and concurrent submits converge', async ({ browser, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Custody concurrency runs once.');
  await login(page); await openPrepare(page); await fixAndCheck(page); await sealAndSign(page);

  await apiPost(page, 'setRecovery', { flag: 'transaction_failure' });
  const rolledBack = await apiPost(page, 'submit', { idempotencyKey: 'p0-rollback-and-retry' });
  expect(rolledBack.status).toBe(409);
  expect((rolledBack.body.error as { code: string }).code).toBe('DARJ_NOT_RECEIVED');
  const afterRollback = await page.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { receipt: unknown };
  expect(afterRollback.receipt).toBeNull();

  await apiPost(page, 'setRecovery', { flag: 'serialization_once' });
  const lostAfterCommit = await apiPost(page, 'submit', { idempotencyKey: 'p0-rollback-and-retry' });
  expect(lostAfterCommit.status).toBe(503);
  expect((lostAfterCommit.body.error as { code: string }).code).toBe('DARJ_SUBMISSION_RETRY_SAFE');
  const recovered = await apiPost(page, 'submit', { idempotencyKey: 'p0-rollback-and-retry' });
  expect(recovered.status).toBe(200);
  expect(recovered.body.replayed).toBe(true);

  const context = await browser.newContext();
  const concurrent = await context.newPage();
  try {
    await login(concurrent); await openPrepare(concurrent); await fixAndCheck(concurrent); await sealAndSign(concurrent);
    const firstPair = await Promise.all([
      apiPost(concurrent, 'submit', { idempotencyKey: 'p0-concurrent-a' }),
      apiPost(concurrent, 'submit', { idempotencyKey: 'p0-concurrent-b' }),
    ]);
    expect(firstPair.map((result) => result.status).sort()).toEqual([200, 503]);
    const converged = await Promise.all([
      apiPost(concurrent, 'submit', { idempotencyKey: 'p0-concurrent-a' }),
      apiPost(concurrent, 'submit', { idempotencyKey: 'p0-concurrent-b' }),
    ]);
    expect(converged.every((result) => result.status === 200)).toBe(true);
    expect(new Set(converged.map((result) => result.body.receiptId)).size).toBe(1);
  } finally { await context.close(); }
});

test('security headers, cookie boundaries, and CSRF rejection protect mutations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Security boundary runs once.');
  const response = await page.goto('/login');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  expect(response?.headers()['x-frame-options']).toBe('DENY');
  expect(response?.headers()['x-content-type-options']).toBe('nosniff');
  await page.getByRole('button', { name: /Enter Meet’s filing/i }).click();
  await expect(page).toHaveURL(/\/filings$/);
  const cookies = await page.context().cookies();
  expect(cookies.find((cookie) => cookie.name === 'darj_demo_run')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
  expect(cookies.find((cookie) => cookie.name === 'darj_csrf')).toMatchObject({ httpOnly: false, sameSite: 'Strict' });
  const before = await page.evaluate(() => fetch('/api/darj').then((result) => result.json())) as { draft: { version: number; form: Record<string, string> } };
  const rejected = await page.evaluate(async (form) => {
    const result = await fetch('/api/darj', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'saveDraft', form, baseVersion: 17 }) });
    return { status: result.status, body: await result.json() as { error: { code: string } } };
  }, { ...before.draft.form, boardMeetings: '9' });
  expect(rejected.status).toBe(403);
  expect(rejected.body.error.code).toBe('DARJ_AUTH_REQUIRED');
  const after = await page.evaluate(() => fetch('/api/darj').then((result) => result.json())) as { draft: { version: number } };
  expect(after.draft.version).toBe(before.draft.version);
});

test('public and authenticated P0 routes have no serious Axe violations', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Accessibility sweep runs once.');
  for (const path of ['/login', '/evidence', '/limitations']) {
    await page.goto(path);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
  }
  await login(page); await openPrepare(page);
  for (const path of ['/filings', '/services', '/company', '/documents', '/payments', '/guidance', '/about', '/filings/DARJ-DEMO-AOC4-01/prepare', '/recovery', '/demo-controls']) {
    await page.goto(path);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact ?? ''))).toEqual([]);
  }
});

test('mobile journey has no horizontal overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-360', 'This assertion is specific to the 360 px project.');
  await login(page); await openPrepare(page);
  for (const path of ['/filings', '/services', '/company', '/documents', '/payments', '/filings/DARJ-DEMO-AOC4-01/prepare']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
});
