import { expect, test } from '@playwright/test';
import {
  api,
  configureReceiver,
  createProject,
  RECEIVER_IN_NETWORK,
  waitFor,
} from './stack.js';

// The criterion of phase 5: a failed event is diagnosed and retried from
// the browser. The endpoint fails a few times and is then disabled, which
// makes the delivery dead (with five failures in a row the circuit breaker
// would hold the sixth attempt for minutes).
test('diagnoses a failed delivery and retries it', async ({ page }) => {
  const apiKey = createProject(`e2e ${new Date().toISOString()}`);
  const hookline = api(apiKey);
  const type = `e2e.${Date.now()}`;

  await configureReceiver({ status: 500 });
  const endpoint = await hookline.createEndpoint([type]);
  const event = await hookline.publish(type, { order: 42 });
  await waitFor('two failed attempts', async () => {
    const delivery = await hookline.delivery(event.id);
    return delivery.attempt_count >= 2;
  });
  await hookline.disableEndpoint(endpoint.id);
  await waitFor('the delivery to be dead', async () => {
    const delivery = await hookline.delivery(event.id);
    return delivery.status === 'dead' && delivery;
  });

  // Sign in. The key never leaves this test or the page's memory.
  await page.goto('/');
  await page.getByLabel('API key').fill(apiKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Events' })).toBeVisible();

  // Find it among the failed deliveries and read why it failed.
  await page.getByRole('link', { name: 'Failed' }).click();
  await page.getByRole('link', { name: type }).click();
  await expect(page.getByText('dead', { exact: true })).toBeVisible();
  const attempts = page.getByTestId('attempt');
  await expect(attempts.first()).toContainText('500');
  expect(await attempts.count()).toBeGreaterThanOrEqual(2);

  // Fix the endpoint: the receiver answers 200 and the endpoint is switched
  // on again from the dashboard.
  await configureReceiver({ status: 200 });
  await page.getByRole('link', { name: 'Endpoints' }).click();
  const row = page.getByRole('row').filter({ hasText: type });
  await expect(row).toContainText(RECEIVER_IN_NETWORK);
  const active = row.getByRole('switch', { name: 'Active' });
  await expect(active).toHaveAttribute('aria-checked', 'false');
  await active.click();
  await expect(active).toHaveAttribute('aria-checked', 'true');

  // Retry, and watch the delivery succeed without reloading the page.
  await page.getByRole('link', { name: 'Failed' }).click();
  await page.getByRole('link', { name: type }).click();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('succeeded', { exact: true })).toBeVisible();
  await expect(attempts.last()).toContainText('200');
});

test('forgets the key when the page reloads', async ({ page }) => {
  const apiKey = createProject(`e2e reload ${new Date().toISOString()}`);

  await page.goto('/endpoints');
  await page.getByLabel('API key').fill(apiKey);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('API key')).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: localStorage.length,
    session: sessionStorage.length,
    cookies: document.cookie,
  }));
  expect(stored).toEqual({ local: 0, session: 0, cookies: '' });
});
