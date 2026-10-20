import { expect, test } from '@playwright/test';
import { scenarioPage, sweepScreen } from './scenario';
import { IDS } from './fixtures/routing-data.mjs';

/**
 * The routing console against the fixture API served by auth-server.mjs. Every screen is swept for
 * horizontal overflow and axe (wcag2a/2aa/22aa) in light and dark at the three project widths,
 * and must raise no page or console error.
 */
// Each screen is swept twice (light, dark) at every width; a loaded machine needs the room.
test.describe.configure({ timeout: 60_000 });

const POINT = `/routing/points/${IDS.point}`;
const heading = (name: string) => ({ level: 1 as const, name });

test('the overview shows KPIs, the routed-calls chart and the three tabs', async ({
  page,
}, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto('/routing');
  await expect(page.getByRole('heading', heading('Routing'))).toBeVisible();
  await expect(page.getByText('Routed calls').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Table' })).toBeVisible();
  await expect(page.getByRole('row', { name: /Main line/ })).toBeVisible();
  await sweepScreen(page, 'routing-overview', info.project.name, problems);
  await page.getByRole('tab', { name: 'Pools' }).click();
  await expect(page.getByRole('row', { name: /Sales/ })).toBeVisible();
  await sweepScreen(page, 'routing-pools', info.project.name, problems);
  await page.getByRole('tab', { name: 'Hold clips' }).click();
  await expect(page.getByRole('row', { name: /Hold music/ })).toBeVisible();
  await sweepScreen(page, 'routing-clips', info.project.name, problems);
});

test('the overview handles empty, down and disabled installations', async ({ page }, info) => {
  for (const [scenario, text] of [
    ['empty', 'No routing points yet'],
    ['down', 'Routing could not be loaded'],
    ['disabled', 'Routing is not enabled here'],
  ] as const) {
    const problems = await scenarioPage(page, scenario);
    await page.goto('/routing');
    await expect(page.getByText(text).first()).toBeVisible();
    await sweepScreen(page, `routing-overview-${scenario}`, info.project.name, problems);
  }
});

test('the designer opens on the tree, with a route map and inline issues', async ({
  page,
}, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto(POINT);
  await expect(page.getByRole('heading', heading('Main line'))).toBeVisible();
  // The drawing is hidden on a phone, where the outline is the route map.
  await expect(page.getByRole('list', { name: 'Route map as an outline' })).toBeAttached();
  if (info.project.name !== 'phone-390')
    await expect(page.getByRole('img', { name: /Route map/ })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Questions and branches' })).toBeVisible();
  await expect(page.getByText('Published v3').first()).toBeVisible();
  await sweepScreen(page, 'routing-designer-tree', info.project.name, problems);
});

for (const [tab, marker] of [
  ['Lines & languages', 'Every line, audited'],
  ['Hold & transfer', 'Transfer targets'],
  ['Human queues', 'Person queues'],
  ['Numbers', 'Bind a number'],
  ['Releases', 'Publish…'],
  ['Simulate', 'Run the simulation'],
] as const) {
  test(`the designer ${tab} tab renders and is accessible`, async ({ page }, info) => {
    const problems = await scenarioPage(page, 'rich');
    await page.goto(POINT);
    await page.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await expect(page.getByText(marker).first()).toBeVisible();
    await sweepScreen(
      page,
      `routing-designer-${tab.split(' ')[0]!.toLowerCase()}`,
      info.project.name,
      problems,
    );
  });
}

test('the keyboard opens a question, an edit shows its issue inline and publish previews', async ({
  page,
}, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto(POINT);
  const first = page.getByRole('treeitem').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  const drawer = page.getByRole('dialog', { name: /Question: intent/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Member sales-ta has no priced meter')).toBeVisible();
  await sweepScreen(page, 'routing-node-drawer', info.project.name, problems);
  await drawer.getByLabel('Question id').fill('Not a key');
  await drawer.getByRole('button', { name: 'Rename' }).click();
  await expect(drawer.getByText(/lowercase letters/i)).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).first().click();
  await page.getByRole('button', { name: 'Publish…' }).first().click();
  const publish = page.getByRole('dialog', { name: 'Publish a release' });
  await expect(publish.getByText('This would create')).toBeVisible();
  await expect(publish.getByText('Added queue binding desk')).toBeVisible();
  await sweepScreen(page, 'routing-publish', info.project.name, problems);
});

test('the pool editor shows members, live load and who would answer', async ({ page }, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto(`/routing/pools/${IDS.sales}`);
  await expect(page.getByRole('heading', heading('Sales'))).toBeVisible();
  await expect(page.getByRole('row', { name: /sales-hi/ })).toBeVisible();
  await sweepScreen(page, 'routing-pool', info.project.name, problems);
  await page.getByRole('button', { name: 'Who would answer?' }).click();
  await page.getByLabel("Caller's language", { exact: true }).selectOption('hi');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('Picked a member')).toBeVisible();
});

test('the simulator runs a scripted caller and reads out the path', async ({ page }, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto(`/routing/simulate?point=${IDS.point}`);
  await page.getByRole('button', { name: 'Add a turn' }).click();
  await page.getByLabel('Turn 1 type').selectOption('dtmf');
  await page.getByLabel('Turn 1 keys').fill('1');
  await page.getByRole('button', { name: 'Run the simulation' }).click();
  await expect(page.getByRole('list', { name: 'Route taken' })).toBeVisible();
  await expect(page.getByText(/Agent agent-sales/).first()).toBeVisible();
  await sweepScreen(page, 'routing-simulate', info.project.name, problems);
});

test('an unscripted model offers Answer as and re-runs', async ({ page }) => {
  await scenarioPage(page, 'rich');
  await page.goto(`/routing/simulate?point=${IDS.point}`);
  await page.getByRole('button', { name: 'Add a turn' }).click();
  await page.getByLabel('Turn 1 words').fill('mujhe naya credit card chahiye');
  await page.getByRole('button', { name: 'Run the simulation' }).click();
  await page.getByRole('button', { name: 'Answer as…' }).first().click();
  await page.getByRole('button', { name: 'Answer and run again' }).click();
  await expect(page.getByText(/Pool|Agent agent-sales/).first()).toBeVisible();
});

test('a stale save shows what the server changed and overwrites nothing', async ({ page }) => {
  await scenarioPage(page, 'rich');
  await page.goto(`/routing/points/${IDS.point2}`);
  await page.getByRole('tab', { name: /^Lines/ }).click();
  await page.getByLabel('Greeting (en)').fill('Hello from my edit');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('This point changed on the server.')).toBeVisible();
  await expect(page.getByLabel('Greeting (en)')).toHaveValue('Hello from my edit');
});

test('a viewer can read the designer but not change it', async ({ page }) => {
  await scenarioPage(page, 'rich', 'viewer');
  await page.goto(POINT);
  await expect(page.getByText('You can read this point but not change it')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
});

test('the designer and pool pages say so when routing is off', async ({ page }, info) => {
  const problems = await scenarioPage(page, 'disabled');
  await page.goto(POINT);
  await expect(page.getByText('Routing is not enabled here')).toBeVisible();
  await page.goto(`/routing/pools/${IDS.sales}`);
  await expect(page.getByText('Routing is not enabled here')).toBeVisible();
  await page.goto('/routing/simulate');
  await expect(page.getByText('Routing is not enabled here')).toBeVisible();
  await sweepScreen(page, 'routing-disabled', info.project.name, problems);
});

test('a queue shows its activity and links to the designer that binds it', async ({
  page,
}, info) => {
  const problems = await scenarioPage(page, 'rich');
  await page.goto('/operations/queues');
  // The "Used by" column drops out on a phone, so the link is present in the table either way.
  await expect(page.locator('a[href^="/routing/points/"]').first()).toBeAttached();
  await page.getByRole('button', { name: 'Activity of Support desk' }).click();
  const drawer = page.getByRole('dialog', { name: 'Activity: Support desk' });
  await expect(drawer.getByRole('region', { name: 'Recent tickets' })).toBeVisible();
  await expect(drawer.getByText('64')).toBeVisible();
  await sweepScreen(page, 'queue-activity', info.project.name, problems);
});

test('queue activity says human queues are off when they are', async ({ page }) => {
  await scenarioPage(page, 'disabled');
  await page.goto('/operations/queues');
  await expect(page.getByText('Human queues are not enabled here')).toBeVisible();
});
