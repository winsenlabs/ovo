import { expect, test } from '@playwright/test';
import { arrange, sweep } from './visibility-support';

/**
 * The call inspector and calls list on routed calls (Wave 18), against the fixture API served by
 * auth-server.mjs. Every screen is captured and swept for horizontal overflow and axe in light
 * and dark at the three project widths, and must not raise a page or console error.
 */

test('a routed call: the header names its route and the transcript is split by segment', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-routed-1');
  await expect(page.getByRole('heading', { level: 1, name: 'Front desk call' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Routed to Agent · 4 segments' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Segment 1 - Sales agent, after routing' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 3, name: 'Segment 2 - Billing agent, after transfer' }),
  ).toBeVisible();
  await expect(page.getByText('Billing here. I can see the duplicate charge.')).toBeVisible();
  await sweep(page, 'inspector-conversation', info, problems);
});

test('Route & segments: KPIs, timeline, route taken, segments, transfers and the person', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-routed-1');
  await page.getByRole('tab', { name: 'Route & segments' }).click();
  await expect(page).toHaveURL(/tab=route/);
  const strip = (label: string) =>
    page.locator('.ds-kpi', {
      has: page.locator('.ds-kpi-label', { hasText: new RegExp(`^${label}$`) }),
    });
  await expect(strip('Route target')).toContainText('Agent');
  await expect(strip('Segments')).toContainText('4');
  await expect(strip('Transfers')).toContainText('1 refused · 2 connected');
  await expect(strip('Hold total')).toContainText('25s');
  await expect(page.getByRole('heading', { name: 'Segment timeline' })).toBeVisible();
  const trail = page.getByRole('navigation', { name: 'Route path' });
  await expect(trail).toContainText('Rules · 100%');
  await expect(trail).toContainText('LLM · 91%');
  await expect(trail).toContainText('Fallback: Reask taken');
  await expect(page.getByRole('region', { name: 'Segments' })).toBeVisible();
  const transfers = page.getByRole('region', { name: 'Transfers' });
  await expect(transfers).toContainText('no_eligible_member');
  await expect(transfers).toContainText('Accepted, queued');
  // A refused request and the next accepted one share a number, as the worker records them.
  await expect(transfers.getByRole('row')).toHaveCount(4);
  await expect(transfers.getByText('#1')).toHaveCount(2);
  const person = page.getByRole('region', { name: 'Person' });
  await expect(person).toContainText('u-asha');
  await sweep(page, 'inspector-route', info, problems);
});

test('the timeline has a table alternative that carries the same marks', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-routed-1?tab=route');
  await expect(page.getByRole('heading', { name: 'Segment timeline' })).toBeVisible();
  await page.getByRole('radio', { name: 'Table' }).click();
  const table = page.getByRole('region', { name: /as a table/ });
  await expect(table).toContainText('Caller held 21s, Connected');
  await expect(table).toContainText('Disclosure');
  await sweep(page, 'inspector-route-table', info, problems);
});

test('a segment opens in a drawer with its transcript, and the link survives a reload', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-routed-1?tab=route');
  await page.getByRole('button', { name: 'Open segment 2' }).click();
  const drawer = page.getByRole('dialog', { name: 'Segment 2: Billing agent' });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/segment=2/);
  await expect(drawer.getByText('Billing here. I can see the duplicate charge.')).toBeVisible();
  await sweep(page, 'inspector-segment-drawer', info, problems);
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Segment 2: Billing agent' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).not.toHaveURL(/segment=/);
});

test('the person segment opens from a deep link', async ({ page }) => {
  await arrange(page, 'rich');
  await page.goto('/calls/call-routed-1?tab=route&segment=3');
  const drawer = page.getByRole('dialog', { name: 'Segment 3: Person · desk' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('queue:desk')).toBeVisible();
});

test('a call that was never routed has no route tab, chip or dividers', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-direct-1');
  await expect(page.getByRole('heading', { level: 1, name: 'Sales agent call' })).toBeVisible();
  await expect(page.getByText('Billing here. I can see the duplicate charge.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Route & segments' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Routed to/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 3, name: /^Segment/ })).toHaveCount(0);
  await sweep(page, 'inspector-direct', info, problems);
});

test('an installation that keeps no outcomes says the route was not stored', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-unavailable-1');
  await page.getByRole('tab', { name: 'Route & segments' }).click();
  await expect(page.getByText('Route data is not stored here')).toBeVisible();
  await sweep(page, 'inspector-route-unavailable', info, problems);
});

test('a failing segments endpoint keeps the call and offers Retry', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls/call-segdown-1?tab=route');
  await expect(page.getByRole('heading', { level: 1, name: 'Sales agent call' })).toBeVisible();
  await expect(page.getByText('The outcome store is down')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await sweep(page, 'inspector-route-error', info, problems);
});

test('a failing API shows the error state with Retry', async ({ page }, info) => {
  const problems = await arrange(page, 'down');
  await page.goto('/calls/call-routed-1');
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await sweep(page, 'inspector-down', info, problems);
});

test('the calls list shows a Route column', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls');
  await expect(page.getByRole('heading', { level: 1, name: 'Calls' })).toBeVisible();
  const routed = page.locator('tr', { has: page.getByTitle('call-routed-1', { exact: true }) });
  await expect(routed.getByRole('link', { name: 'Main line' })).toBeVisible();
  await expect(routed).toContainText('Transferred');
  await expect(routed).toContainText('Person');
  await expect(
    page.locator('tr', { has: page.getByTitle('call-direct-1', { exact: true }) }),
  ).toContainText('Direct');
  await sweep(page, 'calls-route', info, problems);
});

test('routing filters narrow the list and live in the URL', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/calls');
  await expect(page.getByLabel('Routing point')).toBeVisible();
  await page.locator('label.ds-switch', { hasText: 'Transferred' }).click();
  await expect(page).toHaveURL(/transferred=1/);
  await expect(page.getByTitle('call-routed-1', { exact: true })).toBeVisible();
  await expect(page.getByTitle('call-direct-1', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Clear Transferred' })).toBeVisible();
  await sweep(page, 'calls-filtered', info, problems);
  await page.getByLabel('Routing point').selectOption('point-2');
  await expect(page.getByText('No calls match. Clear filters.')).toBeVisible();
  await sweep(page, 'calls-filtered-empty', info, problems);
  await page.getByRole('button', { name: 'Clear all' }).click();
  await expect(page.getByTitle('call-direct-1', { exact: true })).toBeVisible();
});

test('a fallback filter finds the degraded route', async ({ page }) => {
  await arrange(page, 'rich');
  await page.goto('/calls?fallback=1');
  await expect(page.getByTitle('call-fallback-1', { exact: true })).toBeVisible();
  await expect(page.getByTitle('call-direct-1', { exact: true })).toHaveCount(0);
});

test('with routing off the filters are hidden, and a link that carries one is explained', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'disabled');
  await page.goto('/calls');
  await expect(page.getByTitle('call-routed-1', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Routing point')).toHaveCount(0);
  await sweep(page, 'calls-routing-off', info, problems);
  await page.goto('/calls?human=1');
  await expect(
    page.getByText(/Routing filters are not applied\. Routing is not enabled here\./),
  ).toBeVisible();
  await sweep(page, 'calls-routing-off-link', info, problems);
});

test('without call outcomes the filters say they cannot apply', async ({ page }, info) => {
  const problems = await arrange(page, 'rich', 'nooutcomes');
  await page.goto('/calls?human=1');
  await expect(page.getByText(/does not store call outcomes \(PostgreSQL only\)/)).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Reached a person' })).toBeDisabled();
  await sweep(page, 'calls-no-outcomes', info, problems);
});

test('an empty calls list says so', async ({ page }, info) => {
  const problems = await arrange(page, 'empty');
  await page.goto('/calls');
  await expect(page.getByText('No calls yet. Run a test call from an agent.')).toBeVisible();
  await sweep(page, 'calls-empty', info, problems);
});
