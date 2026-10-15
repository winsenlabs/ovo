import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { noOverflowOrAxe, signedIn } from './helpers';

/**
 * The operator desk and human queue screens against the fixture API served by auth-server.mjs
 * (rich, empty, down and disabled scenarios). Each screen is captured and swept for horizontal
 * overflow and axe (wcag2a/2aa/22aa) in light and dark at the three project widths, and must not
 * raise a page error or a console error.
 */
type Scenario = 'rich' | 'empty' | 'down' | 'disabled';
const SCHEMES = ['light', 'dark'] as const;

async function arrange(page: Page, scenario: Scenario) {
  await signedIn(page);
  await page
    .context()
    .addCookies([{ name: 'ovo_fixture', value: scenario, domain: '127.0.0.1', path: '/' }]);
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    // The fixture "down" scenario answers 503 on purpose; the browser logs the failed load.
    if (
      message.type() === 'error' &&
      !/status of 503|ERR_|Failed to load resource/.test(message.text())
    )
      problems.push(`console: ${message.text()}`);
  });
  return problems;
}

async function sweep(page: Page, name: string, info: TestInfo, problems: string[]) {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await noOverflowOrAxe(page);
    await page.screenshot({
      path: `test-results/captures/${name}-${scheme}-${info.project.name}.png`,
      fullPage: true,
    });
  }
  expect(problems).toEqual([]);
}

test('the desk shows the queue, KPIs and presence', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/desk');
  await expect(page.getByRole('heading', { level: 1, name: 'Operator desk' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Callers waiting' })).toBeVisible();
  await expect(page.getByText('Support desk').first()).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Presence' })).toBeVisible();
  await expect(page.getByText('Waiting now').locator('..').getByText('4')).toBeVisible();
  await expect(page.getByText('Offered to you')).toBeVisible();
  await sweep(page, 'desk', info, problems);
});

test('accepting a call opens the active-call panel with live captions', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/desk');
  await page.getByRole('button', { name: /Accept call from \+91••••4321/ }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Active call' })).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const room = (window as unknown as { __ovoFakeRoom: { simulateCaption(c: unknown): void } })
      .__ovoFakeRoom;
    const at = Date.now();
    room.simulateCaption({
      role: 'caller',
      text: 'Meri instalment do baar kat gayi.',
      final: true,
      at,
    });
    room.simulateCaption({
      role: 'operator',
      text: 'Main abhi check karti hoon.',
      final: true,
      at: at + 2_000,
    });
    room.simulateCaption({
      role: 'caller',
      text: 'Theek hai, dhanyavaad',
      final: false,
      at: at + 4_000,
    });
  });
  await expect(page.getByText('Main abhi check karti hoon.')).toBeVisible();
  await expect(page.getByText('Before the transfer')).toBeVisible();
  await sweep(page, 'desk-active', info, problems);
  await page.getByRole('tab', { name: 'Summary' }).click();
  await expect(page.getByText('Written by the AI agent that transferred the call')).toBeVisible();
  await page.getByRole('tab', { name: 'Details' }).click();
  await expect(page.getByText('SF-100482', { exact: false })).toBeVisible();
  await sweep(page, 'desk-active-details', info, problems);
});

test('the hang-up confirmation and the send-back menu are reachable and accessible', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/desk');
  await page.getByRole('button', { name: /Accept call from \+91••••4321/ }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.getByLabel('Send back to', { exact: true }).selectOption('billing-bot');
  await page.getByRole('button', { name: 'Hang up' }).click();
  await expect(page.getByRole('dialog', { name: 'Hang up' })).toBeVisible();
  await sweep(page, 'desk-hangup', info, problems);
});

test('an empty floor says what that means', async ({ page }, info) => {
  const problems = await arrange(page, 'empty');
  await page.goto('/desk');
  await expect(page.getByText('No callers waiting')).toBeVisible();
  await sweep(page, 'desk-empty', info, problems);
});

test('a failing API keeps the header and offers Retry', async ({ page }, info) => {
  const problems = await arrange(page, 'down');
  await page.goto('/desk');
  await expect(page.getByRole('heading', { level: 1, name: 'Operator desk' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  await sweep(page, 'desk-down', info, problems);
});

test('a switched-off feature is explained, not broken', async ({ page }, info) => {
  const problems = await arrange(page, 'disabled');
  await page.goto('/desk');
  await expect(page.getByText('The operator desk is not enabled here')).toBeVisible();
  await sweep(page, 'desk-disabled', info, problems);
});

test('human queues lists webhook and desk queues with live numbers', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/operations/queues');
  await expect(page.getByRole('heading', { level: 1, name: 'Human queues' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Human queues' })).toBeVisible();
  await expect(page.getByText('Acme call centre')).toBeVisible();
  await sweep(page, 'queues', info, problems);
});

test('the webhook queue drawer previews the body and shows a test result', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/operations/queues');
  await page.getByRole('button', { name: 'Edit Acme call centre' }).click();
  const drawer = page.getByRole('dialog', { name: 'Edit Acme call centre' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('"callId": "call-test"')).toBeVisible();
  await drawer.getByRole('button', { name: 'Send test webhook' }).click();
  await expect(drawer.getByText('Test result')).toBeVisible();
  await expect(drawer.getByText('Inside the allow-list')).toBeVisible();
  await sweep(page, 'queues-drawer', info, problems);
});

test('the desk queue drawer and the operators tab sweep clean', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await page.goto('/operations/queues');
  await page.getByRole('button', { name: 'New operator desk queue' }).first().click();
  await expect(page.getByRole('dialog', { name: /New operator desk queue/i })).toBeVisible();
  await sweep(page, 'queues-drawer-desk', info, problems);
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Operators' }).click();
  await expect(page.getByRole('region', { name: 'Operators' })).toBeVisible();
  await expect(page.getByText('Ravi Shah', { exact: true }).first()).toBeVisible();
  await sweep(page, 'queues-operators', info, problems);
});
