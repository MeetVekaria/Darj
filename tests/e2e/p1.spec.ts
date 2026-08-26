import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: /Open sample company workspace/i }).click();
  await expect(page).toHaveURL(/\/filings$/);
}

async function openPrepare(page: Page) {
  await page.getByRole('button', { name: /Continue filing|View record/i }).first().click();
  await expect(page.getByRole('heading', { name: 'Prepare AOC-4' })).toBeVisible();
}

async function apiPost(page: Page, action: string, data: Record<string, unknown> = {}) {
  return page.evaluate(async ({ requestedAction, requestedData }) => {
    const csrf = document.cookie.split(';').map((item) => item.trim()).find((item) => item.startsWith('darj_csrf='))?.split('=')[1] ?? '';
    const response = await fetch('/api/darj', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DARJ-CSRF': decodeURIComponent(csrf) }, body: JSON.stringify({ action: requestedAction, ...requestedData }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { requestedAction: action, requestedData: data });
}

async function completeAcceptedV23(page: Page) {
  await login(page); await openPrepare(page);
  await page.getByLabel('Board meetings').fill('4');
  await expect(page.getByText('Saved locally · Synced').first()).toBeVisible();
  await page.getByRole('button', { name: /Run Jaanch/i }).click();
  await page.getByRole('button', { name: /Create Mohar/i }).click();
  await page.getByRole('button', { name: /Continue to test signing/i }).click();
  await page.getByRole('button', { name: /Submit exact package/i }).click();
  await page.getByRole('button', { name: /Approve simulated payment/i }).click();
  await expect(page.getByText('PAID · RECONCILED', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Track processing/i }).click();
  await page.getByRole('button', { name: 'Pause processor' }).click();
  await page.getByRole('button', { name: /Resume and finish processing/i }).click();
  await expect(page.getByRole('heading', { name: 'ACCEPTED' })).toBeVisible();
}

test('P1 resumable upload survives reload and resumes from the server-confirmed R2 offset', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The multipart recovery proof runs once.');
  await login(page); await openPrepare(page);
  await apiPost(page, 'setRecovery', { flag: 'upload_pause' });
  await page.reload();
  const body = Buffer.alloc(7 * 1024 * 1024, 32);
  Buffer.from('%PDF-1.4\n').copy(body, 0);
  Buffer.from('\n%%EOF').copy(body, body.length - 6);
  const payload = { name: 'DARJ-large-board-report.pdf', mimeType: 'application/pdf', buffer: body };
  const boardRow = page.locator('.attachment-row').filter({ hasText: 'Board report' });
  await boardRow.locator('input[type=file]').setInputFiles(payload);
  await expect(page.getByText(/Upload paused · 6\.0 MB of 7\.0 MB safely stored/i)).toBeVisible({ timeout: 30_000 });
  const paused = await page.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { uploadSessions: Array<{ slot: string; confirmedOffset: number; expectedBytes: number; state: string }> };
  expect(paused.uploadSessions.find((session) => session.slot === 'boardReport')).toMatchObject({ confirmedOffset: 6 * 1024 * 1024, expectedBytes: 7 * 1024 * 1024, state: 'UPLOADING' });

  await page.reload();
  await expect(boardRow.getByText(/6\.0 MB of 7\.0 MB safely stored/i)).toBeVisible();
  await boardRow.locator('input[type=file]').setInputFiles(payload);
  await expect(page.getByText(/TUS complete.*durable R2 object/i)).toBeVisible({ timeout: 30_000 });
  const completed = await page.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { attachments: Array<{ slot: string; bytes: number }>; uploadSessions: Array<{ slot: string; confirmedOffset: number; state: string }> };
  expect(completed.attachments.find((attachment) => attachment.slot === 'boardReport')?.bytes).toBe(7 * 1024 * 1024);
  expect(completed.uploadSessions.find((session) => session.slot === 'boardReport')).toMatchObject({ confirmedOffset: 7 * 1024 * 1024, state: 'COMPLETE' });
});

test('P1 company master drift blocks sealing until Meet explicitly accepts a new snapshot', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Master drift runs once.');
  await login(page); await openPrepare(page);
  await page.getByLabel('Board meetings').fill('4');
  await expect(page.getByText('Saved locally · Synced').first()).toBeVisible();
  await apiPost(page, 'setRecovery', { flag: 'master_drift' });
  await page.reload();
  await expect(page.getByRole('heading', { name: /Registered office changed/i })).toBeVisible();
  await expect(page.getByText('14, Demo Business Park, Ahmedabad, Gujarat 380015').first()).toBeVisible();
  await expect(page.getByText('27, Riverfront Commerce Centre, Ahmedabad, Gujarat 380009')).toBeVisible();
  await page.getByRole('button', { name: /Run Jaanch/i }).click();
  await expect(page.getByText('DARJ_MASTER_DATA_DRIFT')).toBeVisible();
  await expect(page.getByRole('button', { name: /Create Mohar/i })).toHaveCount(0);
  const blockedSeal = await apiPost(page, 'seal');
  expect(blockedSeal.status).toBe(409);
  expect((blockedSeal.body.error as { code: string }).code).toBe('DARJ_JAANCH_FAILED');
  await page.getByRole('button', { name: /Go to exact field/i }).click();
  await page.getByRole('button', { name: /Accept current snapshot/i }).click();
  await expect(page.getByRole('textbox', { name: 'Registered office', exact: true })).toHaveValue('27, Riverfront Commerce Centre, Ahmedabad, Gujarat 380009');
  await expect(page.getByText('Snapshot 8', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Run Jaanch/i }).click();
  await expect(page.getByRole('heading', { name: '43 checks · 43 passed · 0 needs attention' })).toBeVisible();
});

test('P1 correction creates linked v24 and leaves accepted v23 unchanged', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Correction lineage runs once.');
  await completeAcceptedV23(page);
  const before = await page.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { package: { packageId: string; version: number; hash: string; canonicalPayload: string } };
  expect(before.package.version).toBe(23);
  await apiPost(page, 'requestCorrection');
  await page.goto('/filings/DARJ-DEMO-AOC4-01/lineage');
  await expect(page.getByText('Return resubmission required for board report.')).toBeVisible();
  await page.getByRole('button', { name: /Create corrected v24/i }).click();
  await expect(page.getByText('DARJ-PKG-000023 · v23')).toBeVisible();
  await expect(page.getByText('DARJ-PKG-000024 · v24')).toBeVisible();
  await expect(page.getByText('attachments.boardReport')).toBeVisible();
  const after = await page.evaluate(() => fetch('/api/darj').then((response) => response.json())) as { package: { packageId: string; version: number; hash: string }; lineage: Array<{ parent: { hash: string; version: number }; child: { hash: string; version: number }; changedPaths: string[] }> };
  expect(after.lineage[0].parent).toMatchObject({ hash: before.package.hash, version: 23 });
  expect(after.lineage[0].child.version).toBe(24);
  expect(after.lineage[0].child.hash).not.toBe(before.package.hash);
  expect(after.lineage[0].changedPaths).toEqual(['attachments.boardReport']);
  expect(before.package.canonicalPayload).toContain('DARJ-PKG-000023');
  await page.getByRole('button', { name: /Open v24 Mohar/i }).click();
  await page.getByRole('button', { name: /Continue to test signing/i }).click();
  await page.getByRole('button', { name: /Submit exact package/i }).click();
  await expect(page.getByText('DARJ-RASID-0024').first()).toBeVisible();
});

test('sign out clears the authenticated cookies and keeps recoverable local work', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Cookie and IndexedDB behavior runs once.');
  await login(page); await openPrepare(page);
  await page.getByLabel('Board meetings').fill('6');
  await expect(page.getByText('Saved locally · Synced').first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('button', { name: /Open sample company workspace/i })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(cookies.some((cookie) => ['darj_demo_run', 'darj_csrf'].includes(cookie.name))).toBe(false);
  const local = await page.evaluate(() => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('darj-local-v2');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction('records', 'readonly');
      const get = transaction.objectStore('records').get('draft:DARJ-DEMO-AOC4-01');
      get.onsuccess = () => resolve(get.result?.value ?? null);
    };
  })) as { form: { boardMeetings: string } };
  expect(local.form.boardMeetings).toBe('6');
});

test('paired insertion fields and attachment actions align on desktop', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop alignment runs once.');
  await login(page); await openPrepare(page);
  for (const [left, right] of [['field-fy', 'field-agm'], ['field-revenue', 'field-expenses'], ['field-director', 'field-boardMeetings']]) {
    const [leftBox, rightBox] = await Promise.all([page.locator(`#${left}`).boundingBox(), page.locator(`#${right}`).boundingBox()]);
    expect(Math.abs((leftBox?.y ?? 0) - (rightBox?.y ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs((leftBox?.height ?? 0) - (rightBox?.height ?? 0))).toBeLessThanOrEqual(1);
  }
  const actionBoxes = await page.locator('.attachment-actions').evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect(); return { x: box.x, width: box.width };
  }));
  expect(new Set(actionBoxes.map((box) => Math.round(box.x))).size).toBe(1);
  expect(new Set(actionBoxes.map((box) => Math.round(box.width))).size).toBe(1);
});

test('mobile insertion controls use one aligned column with no overflow', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-360', 'Mobile alignment runs once.');
  await login(page); await openPrepare(page);
  const widths = await page.locator('.field input').evaluateAll((inputs) => inputs.map((input) => Math.round(input.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('button', { name: 'Sign out' }).first()).toBeVisible();
});
