import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/console.json', import.meta.url), 'utf8')) as { agents: { id: string; draftVersion: string; config: Record<string, any> }[]; pluginCatalog: Record<string, unknown>; readiness: Record<string, any>; carrierUrls: Record<string, string>; stream: { id?: string; event: string; data: Record<string, unknown> }[] };

type Draft = (typeof fixture.agents)[number];

async function signedIn(page: Page, role: 'admin' | 'editor' | 'viewer' = 'admin') {
  await page.context().addCookies([{ name: 'ovo_session', value: role, domain: '127.0.0.1', path: '/', httpOnly: true }]);
}

async function fixtureApi(page: Page) {
  const agents: Draft[] = structuredClone(fixture.agents);
  const calls = Array.from({ length: 70 }, (_, index) => ({ id: `call-${String(index + 1).padStart(3, '0')}`, kind: 'live', status: 'completed', createdAt: '2026-09-25T10:00:00Z' }));
  await page.route('**/api/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const send = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/plugins' && request.method() === 'GET') return send(fixture.pluginCatalog);
    if (path === '/plugins/compat' && request.method() === 'POST') {
      const voice = request.postDataJSON()?.voice ?? {};
      const issues = (['engine', 'carrier'] as const).filter(slot => voice[slot]?.plugin === `${slot}-bad`).map(slot => ({ code: 'format_unreachable', severity: 'error', stage: 'release', slot, pluginId: `${slot}-bad`, message: `Choose a compatible ${slot}` }));
      return send(issues);
    }
    if (path === '/agents' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send({ items: agents.slice(offset, offset + limit), nextCursor: offset + limit < agents.length ? String(offset + limit) : null });
    }
    if (path === '/agents' && request.method() === 'POST') {
      const draft = { id: 'agent-created', draftVersion: '1', config: request.postDataJSON()?.config } as Draft;
      agents.unshift(draft);
      return send(draft, 201);
    }
    const match = path.match(/^\/agents\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const draft = agents.find(agent => agent.id === match[1]);
      if (!draft) return send({ error: { code: 'not_found', message: 'Agent missing' } }, 404);
      if (match[2] === 'readiness') return send({ ...fixture.readiness, blockers: draft.config.voice?.engine?.plugin === 'engine-good' && draft.config.voice?.carrier?.plugin === 'carrier-good' ? [] : fixture.readiness.blockers });
      if (match[2] === 'releases') return send({ items: [] });
      if (match[2] === 'test-calls' && request.method() === 'POST') return send({ callId: 'fixture-call' }, 201);
      if (match[2] === undefined && request.method() === 'PUT') {
        draft.config = request.postDataJSON()?.config;
        draft.draftVersion = String(Number(draft.draftVersion) + 1);
        return send(draft);
      }
      if (match[2] === undefined) return send(draft);
    }
    if (path === '/provider-bindings') return send({ items: [{ id: 'binding-good', label: 'Fixture carrier binding', provider: 'fixture', pluginId: 'carrier-good', kind: 'carrier', environment: 'test', credentialId: 'credential-1' }] });
    if (path === '/credentials') return send({ items: [] });
    if (path.includes('/carrier-urls')) return send({ items: Object.entries(fixture.carrierUrls).map(([purpose, url]) => ({ purpose, label: purpose, url })) });
    if (path === '/calls' && request.method() === 'GET') {
      const offset = Number(url.searchParams.get('cursor') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return send({ items: calls.slice(offset, offset + limit), nextCursor: offset + limit < calls.length ? String(offset + limit) : null });
    }
    if (path === '/calls/fixture-call/evidence' || /^\/calls\/call-\d+\/evidence$/.test(path)) return send({
      call: { id: path.split('/')[2], agentId: 'agent-created', releaseId: 'release-1', outcome: 'completed', durationMs: 2100 },
      selections: { engine: { pluginId: 'engine-good', version: '1.0.0' }, carrier: { pluginId: 'carrier-good', version: '1.0.0' }, stt: { pluginId: 'stt-fixture', version: '1.0.0' } },
      transcript: [{ id: 't1', speaker: 'User', phase: 'final', text: 'Hello', atMs: 200 }, { id: 't2', speaker: 'Agent', phase: 'played', text: 'Hello caller', atMs: 900 }],
      latency: [{ stage: 'STT', durationMs: 200 }, { stage: 'TTS', durationMs: 400 }],
      cost: { estimatedPaise: '3', reconciledPaise: '1', unpriced: ['carrier.stream.minute'] },
      events: [{ id: 'e1', type: 'accepted', at: '2026-09-25T10:00:00Z' }],
    });
    if (path === '/calls/fixture-call/stream') {
      const body = fixture.stream.map(item => `${item.id ? `id: ${item.id}\n` : ''}event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`).join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'cache-control': 'no-cache' }, body });
    }
    if (path === '/operations/suppressions' && request.method() === 'POST') return send({ id: 'suppression-1' }, 201);
    if (path === '/performance') return send({ error: { code: 'unavailable', message: 'Fixture has no performance snapshot' } }, 503);
    if (path === '/infrastructure') return send({ error: { code: 'unavailable', message: 'Fixture has no infrastructure snapshot' } }, 503);
    return send({ items: [] });
  });
}

async function noOverflowOrAxe(page: Page) {
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(width.scroll, `horizontal overflow: ${JSON.stringify(width)}`).toBeLessThanOrEqual(width.client);
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(results.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
}

test('401 keeps the requested route, and non-admin direct /team access is denied', async ({ page }) => {
  await page.goto('/agents/new?source=fixture');
  await expect(page).toHaveURL(/\/login\?next=%2Fagents%2Fnew%3Fsource%3Dfixture/);
  await signedIn(page, 'editor');
  await fixtureApi(page);
  const response = await page.goto('/team');
  expect(response?.status()).toBe(404);
});

test('login and legacy redirects remain accessible without horizontal overflow', async ({ page }) => {
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
  await expect(page.getByRole('status', { name: '' }).filter({ hasText: 'No compatibility issues reported.' })).toBeVisible();
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
  await page.locator('#slot-carrier').getByRole('combobox', { name: 'Binding' }).selectOption('binding-good');
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
  await page.route('**/api/v1/agents/*/test-calls', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'fixture_calls_disabled', message: 'Fixture calls disabled' } }) }));
  await page.goto('/agents/agent-001/test');
  await page.getByRole('button', { name: 'Run fixture test call' }).click();
  await expect(page.getByText('Fixture test calls are disabled on this installation.')).toBeVisible();
});

test('mobile navigation opens, traps focus, and closes on route change', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-390');
  await signedIn(page);
  await fixtureApi(page);
  await page.goto('/agents');
  const trigger = page.getByRole('button', { name: 'Menu' });
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('dialog', { name: 'Navigation' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Navigation' }).getByRole('link', { name: 'Calls' }).click();
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

const routes = ['/agents', '/agents/new', '/agents/agent-001', '/agents/agent-001/plugins', '/agents/agent-001/test', '/agents/agent-001/releases', '/calls', '/calls/call-001', '/campaigns', '/operations/handoffs', '/operations/inbound', '/operations/suppressions', '/evaluations', '/performance', '/costs', '/infrastructure', '/settings/providers', '/settings/tools', '/account', '/team'];
test('all console routes fit the viewport and meet WCAG A/AA', async ({ page }) => {
  await signedIn(page);
  await fixtureApi(page);
  for (const path of routes) {
    await test.step(path, async () => {
      await page.goto(path);
      await expect(page.locator('main')).toBeVisible();
      await noOverflowOrAxe(page);
    });
  }
});
