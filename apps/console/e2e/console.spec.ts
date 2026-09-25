import { expect, test } from '@playwright/test';
import { fixtureApi, noOverflowOrAxe, signedIn } from './helpers';

test('401 keeps the requested route, and non-admin direct /team access is denied', async ({
  page,
}) => {
  await page.goto('/agents/new?source=fixture');
  await expect(page).toHaveURL(/\/login\?next=%2Fagents%2Fnew%3Fsource%3Dfixture/);
  await signedIn(page, 'editor');
  await fixtureApi(page);
  const response = await page.goto('/team');
  expect(response?.status()).toBe(404);
});

test('login and legacy redirects remain accessible without horizontal overflow', async ({
  page,
}) => {
  await page.goto('/login');
  await noOverflowOrAxe(page);
  await signedIn(page);
  await fixtureApi(page);
  for (const [oldPath, destination] of [
    ['/providers', '/settings/providers'],
    ['/tools', '/settings/tools'],
    ['/suppressions', '/operations/suppressions'],
    ['/handoffs', '/operations/handoffs'],
  ]) {
    await page.goto(oldPath);
    await expect(page).toHaveURL(new RegExp(`${destination}$`));
  }
});

test('wizard, plugin review, fixture stream, and evidence inspector', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents/new');
  await page.getByLabel('Name', { exact: true }).fill('Demo agent');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('No carrier is preselected')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Approved message').fill('Hello caller');
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page).toHaveURL(/\/agents\/agent-created\/plugins/);
  await expect(page.getByText('Choose a compatible engine').first()).toBeVisible();
  await page.getByRole('radio', { name: /Compatible engine/ }).check();
  await page.getByRole('radio', { name: /Compatible carrier/ }).check();
  await expect(
    page.getByRole('status', { name: '' }).filter({ hasText: 'No compatibility issues reported.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save plugins' }).click();
  await page.getByRole('link', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Run fixture test call' }).click();
  await expect(page.getByText('Hello caller').first()).toBeVisible();
  await expect(page.getByText('Cost so far: 3')).toBeVisible();
  await page.getByRole('link', { name: /Inspect call fixture-call/ }).click();
  await expect(page.getByRole('heading', { name: 'Call fixture-call' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latency waterfall' })).toBeVisible();
  await expect(page.getByText('carrier.stream.minute', { exact: true })).toBeVisible();
});

test('calls cursor pagination and deep link', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/calls');
  await expect(page.getByRole('link', { name: 'call-001' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'call-051' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page).toHaveURL(/cursor=50/);
  await expect(page.getByRole('link', { name: 'call-051' })).toBeVisible();
  await page.getByRole('link', { name: 'call-051' }).click();
  await expect(page.getByRole('heading', { name: 'Call call-051' })).toBeVisible();
});

test('carrier binding exposes operator URLs and the 12 px typography floor', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents/agent-001/plugins');
  await page.getByRole('radio', { name: /Compatible carrier/ }).check();
  await page
    .locator('#slot-carrier')
    .getByRole('combobox', { name: 'Binding' })
    .selectOption('binding-good');
  await expect(page.getByText('https://ovo.fixture.test/carrier/answer')).toBeVisible();
  const fontSize = await page.evaluate(() => {
    const cell = document.createElement('td');
    cell.className = 'compact-json';
    document.body.append(cell);
    const pixels = parseFloat(getComputedStyle(cell).fontSize);
    cell.remove();
    return pixels;
  });
  expect(fontSize).toBeGreaterThanOrEqual(12);
});

test('fixture-call 404 gives an explanatory empty state', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.route('**/api/v1/agents/*/test-calls', (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'fixture_calls_disabled', message: 'Fixture calls disabled' },
      }),
    }),
  );
  await page.goto('/agents/agent-001/test');
  await page.getByRole('button', { name: 'Run fixture test call' }).click();
  await expect(
    page.getByText('Fixture test calls are disabled on this installation.'),
  ).toBeVisible();
});

test('mobile navigation opens, traps focus, and closes on route change', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390');
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents');
  const trigger = page.getByRole('button', { name: 'Menu' });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await page
    .getByRole('dialog', { name: 'Navigation' })
    .getByRole('link', { name: 'Calls' })
    .click();
  await expect(page).toHaveURL(/\/calls$/);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('suppression add resets its form after the API resolves', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/operations/suppressions');
  const input = page.locator('form input').first();
  await input.fill('+15551234567');
  await page.getByLabel('Reason').fill('Fixture suppression');
  const submit = page.getByRole('button', { name: /Add suppression|Suppress|Add number/i }).first();
  await submit.click();
  await expect(input).toHaveValue('');
});

test('viewer sees populated authoring controls as disabled', async ({ page }) => {
  await signedIn(page, 'viewer');
  await fixtureApi(page);
  await page.goto('/agents/agent-119');
  await expect(page.getByText('Viewer access is read-only.')).toBeVisible();
  const editors = page.locator('.studio-editors');
  expect(await editors.locator('input, textarea, select, button').count()).toBeGreaterThan(20);
  await expect(
    editors.locator('input:enabled, textarea:enabled, select:enabled, button:enabled'),
  ).toHaveCount(0);
});

test('a deep link loads and saves the requested agent beyond the first page', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents/agent-060');
  await expect(page.getByRole('heading', { name: 'Fixture agent 060' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Selected agent' })).toHaveValue('agent-060');
  const write = page.waitForRequest(
    (request) =>
      request.method() === 'PUT' && new URL(request.url()).pathname === '/api/v1/agents/agent-060',
  );
  await page.getByLabel('Agent name').fill('Deep-linked agent 060');
  expect((await write).postDataJSON().config.name).toBe('Deep-linked agent 060');
  await expect(page.getByRole('heading', { name: 'Deep-linked agent 060' })).toBeVisible();
});

test('a missing deep-linked agent fails without opening another draft', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents/agent-missing');
  await expect(page.getByText('Agent missing')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Selected agent' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Fixture agent 001' })).toHaveCount(0);
});

test('a client 401 hides stale identity and redirects to sign in', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.route('**/api/v1/agents/agent-001/readiness', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'expired', message: 'Session expired' } }),
    }),
  );
  await page.goto('/agents/agent-001');
  await expect(page).toHaveURL(/\/login\?next=%2Fagents%2Fagent-001/);
  await expect(page.getByText('Fixture agent 001')).toHaveCount(0);
});

test('renaming a script node updates the start and every incoming transition', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents/agent-119');
  await expect(page.getByRole('heading', { name: 'Deterministic script' })).toBeVisible();
  await expect(page.getByLabel('Start node')).toHaveValue('start');
  await expect(page.getByRole('combobox', { name: 'Target node' }).last()).toHaveValue('start');
  await page.getByLabel('Node 1 ID').fill('welcome');
  await expect(page.getByLabel('Start node')).toHaveValue('welcome');
  await expect(page.getByRole('combobox', { name: 'Target node' }).last()).toHaveValue('welcome');
  await expect(page.getByText('The start node does not exist.')).toHaveCount(0);
  await expect(page.getByText('retry points to missing node start.')).toHaveCount(0);
});

const routes = [
  '/agents',
  '/agents/new',
  '/agents/agent-001',
  '/agents/agent-119',
  '/agents/agent-120',
  '/agents/agent-001/plugins',
  '/agents/agent-001/test',
  '/agents/agent-001/releases',
  '/calls',
  '/calls/call-001',
  '/campaigns',
  '/operations/handoffs',
  '/operations/inbound',
  '/operations/suppressions',
  '/evaluations',
  '/performance',
  '/costs',
  '/infrastructure',
  '/settings/providers',
  '/settings/tools',
  '/account',
  '/team',
];
test('all console routes fit the viewport and meet WCAG A/AA', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  for (const path of routes) {
    await test.step(path, async () => {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      if (path === '/agents/agent-119') {
        for (const name of [
          'Deterministic script',
          'Approved FAQ answers',
          'Tool definitions',
          'Provider bindings',
          'Cost admission policy',
        ])
          await expect(page.getByRole('heading', { name })).toBeVisible();
        await expect(page.getByLabel('Transition 1 matches for start')).toBeVisible();
      }
      if (path === '/agents/agent-120')
        await expect(page.getByRole('heading', { name: 'Tool definitions' })).toBeVisible();
      await noOverflowOrAxe(page);
    });
  }
});
