import { expect, test, type Page } from '@playwright/test';
import { arrange, sweep } from './visibility-support';

/**
 * The Evaluations "Routing" tab (Wave 18): runs, KPIs, trend, run drawer with the confusion
 * matrix, the run-a-corpus drawer and delete, in the rich, empty, disabled and down scenarios.
 */
const open = async (page: Page) => {
  await page.goto('/evaluations');
  await page.getByRole('tab', { name: 'Routing' }).click();
};
const GOOD = JSON.stringify([
  {
    id: 'sales-hi',
    turns: [{ kind: 'speech', text: 'mujhe naya credit card chahiye' }],
    expect: { status: 'agent' },
  },
  {
    id: 'support-1',
    turns: [{ kind: 'dtmf', digits: '2' }],
    expect: { status: 'agent', branches: { intent: 'support' } },
  },
]);

test('runs, headline numbers and the trend', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await open(page);
  await expect(page.getByText(/score the tree, rules and pools, not model quality/)).toBeVisible();
  const table = page.getByRole('region', { name: 'Routing runs' });
  await expect(table).toContainText('Worked examples');
  await expect(table).toContainText('43 / 45');
  await expect(page.locator('.ds-kpi', { hasText: 'Passed (latest run)' })).toContainText(
    '43 of 45',
  );
  await sweep(page, 'routing-evals', info, problems);
  await page.getByRole('radio', { name: 'Table' }).click();
  await expect(page.getByRole('region', { name: /per run as a table/ })).toContainText(
    'Fallback rate',
  );
  await sweep(page, 'routing-evals-table', info, problems);
});

test('a run opens with accuracy, engines, the confusion matrix, nodes and failures', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await open(page);
  await page.getByRole('button', { name: 'Open run Worked examples' }).click();
  const drawer = page.getByRole('dialog', { name: 'Routing run: Worked examples' });
  await expect(drawer.getByRole('region', { name: 'Accuracy per field' })).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'Per engine' })).toBeVisible();
  const matrix = drawer.getByRole('region', { name: 'LLM confusion matrix' });
  await expect(matrix).toContainText('30 of 33 branches chosen correctly');
  await expect(drawer.getByRole('region', { name: 'Failures' })).toContainText(
    'support-hi-low-confidence',
  );
  await sweep(page, 'routing-evals-run', info, problems);
});

test('run a corpus: the first failing case is named, a valid corpus runs', async ({
  page,
}, info) => {
  const problems = await arrange(page, 'rich');
  await open(page);
  await page.getByRole('button', { name: 'Run a corpus' }).click();
  const drawer = page.getByRole('dialog', { name: 'Run a corpus' });
  await expect(drawer.getByRole('option', { name: 'Main line · v3' })).toBeAttached();
  const corpus = drawer.getByLabel(/^Corpus/);
  await corpus.fill(
    JSON.stringify([
      { id: 'ok', expect: { status: 'agent' } },
      { id: 'bad', expect: { status: 'maybe' } },
    ]),
  );
  await expect(
    drawer.getByText(/Case 2 \(bad\): expect\.status must be one of agent/),
  ).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Run corpus' })).toBeDisabled();
  await sweep(page, 'routing-evals-form-invalid', info, problems);
  await corpus.fill(GOOD);
  await expect(drawer.getByText('2 cases are valid.')).toBeVisible();
  await drawer.getByLabel('Run name').fill('Fixture run');
  await sweep(page, 'routing-evals-form-valid', info, problems);
  await drawer.getByRole('button', { name: 'Run corpus' }).click();
  await expect(page.getByRole('dialog', { name: 'Routing run: Fixture run' })).toBeVisible();
});

test('deleting asks first', async ({ page }, info) => {
  const problems = await arrange(page, 'rich');
  await open(page);
  await page.getByRole('button', { name: 'Delete run Smoke' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete routing run' });
  await expect(dialog).toContainText('Delete Smoke and its stored cases');
  await sweep(page, 'routing-evals-delete', info, problems);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('no runs yet invites the first one', async ({ page }, info) => {
  const problems = await arrange(page, 'empty');
  await open(page);
  await expect(page.getByText('No routing runs yet').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run a corpus' })).toBeVisible();
  await sweep(page, 'routing-evals-empty', info, problems);
});

test('routing switched off is explained, not broken', async ({ page }, info) => {
  const problems = await arrange(page, 'disabled');
  await open(page);
  await expect(page.getByText('Routing is not enabled here', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run a corpus' })).toHaveCount(0);
  await sweep(page, 'routing-evals-disabled', info, problems);
});

test('a failing API keeps the tab and offers Retry', async ({ page }, info) => {
  const problems = await arrange(page, 'down');
  await open(page);
  await expect(page.getByText('Routing runs unavailable')).toBeVisible();
  await expect(page.getByRole('tabpanel').getByRole('button', { name: 'Retry' })).toBeVisible();
  await sweep(page, 'routing-evals-down', info, problems);
});
