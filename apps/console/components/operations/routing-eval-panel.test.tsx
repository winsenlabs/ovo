import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { evalRun, evalSummary, routingEvalApiMock } from '../../tests/routing-eval-fixtures';
import { polyfillDialog } from '../../tests/inspector-fixtures';
import { RoutingEvalPanel } from './routing-eval-panel';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

const older = evalSummary({
  id: 'run-0',
  name: 'Smoke',
  createdAt: '2026-10-17T09:00:00Z',
  headline: { passed: 8, total: 10, accuracy: 0.8, fallbackRate: 0.3, clarifyRate: 0.1 },
});
const newer = evalSummary();
let runs = [newer, older];
let listFailure: Error | undefined;

beforeEach(() => {
  polyfillDialog();
  runs = [newer, older];
  listFailure = undefined;
  request.mockImplementation(
    routingEvalApiMock({ runs: () => runs, listFailure: () => listFailure }),
  );
});
afterEach(() => {
  cleanup();
  request.mockReset();
});

/** The KPI tile with this label (the legend and column headers repeat some of the words). */
const tile = (label: string) =>
  screen
    .getAllByText(label)
    .find((element) => element.classList.contains('ds-kpi-label'))!
    .closest('article') as HTMLElement;
const calledWith = (method: string, path: RegExp) =>
  request.mock.calls.filter(([p, i]) => (i?.method ?? 'GET') === method && path.test(p));

const validCase = (id: string) => ({
  id,
  call: {},
  turns: [{ kind: 'dtmf', digits: '1' }],
  expect: { status: 'agent' },
});

describe('the Routing tab', () => {
  it('always says what an offline run measures', async () => {
    render(<RoutingEvalPanel role="editor" />);
    expect(
      await screen.findByText(/score the tree, rules and pools, not model quality/),
    ).toBeTruthy();
  });

  it('shows skeletons while loading', () => {
    request.mockImplementation(() => new Promise(() => undefined));
    render(<RoutingEvalPanel role="editor" />);
    expect(screen.getAllByRole('status', { name: /Loading/ }).length).toBeGreaterThan(0);
  });

  it('says routing is not enabled when the API answers 404', async () => {
    listFailure = new ApiError(404, 'routing_disabled', 'Routing is not enabled');
    render(<RoutingEvalPanel role="editor" />);
    expect(await screen.findByText('Routing is not enabled here')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run a corpus' })).toBeNull();
  });

  it('shows a failure with Retry, and recovers', async () => {
    listFailure = new ApiError(503, 'unavailable', 'Operations database is down');
    render(<RoutingEvalPanel role="editor" />);
    expect(await screen.findByText('Operations database is down')).toBeTruthy();
    listFailure = undefined;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Routing runs' })).toBeTruthy();
  });

  it('invites the first run when there are none', async () => {
    runs = [];
    render(<RoutingEvalPanel role="editor" />);
    expect(await screen.findAllByText('No routing runs yet')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Run a corpus' })).toBeTruthy();
    expect(within(tile('Accuracy')).getByTitle('Unknown')).toBeTruthy();
  });

  it('headlines the latest run, lists every run and tabulates the trend', async () => {
    render(<RoutingEvalPanel role="editor" />);
    const table = await screen.findByRole('region', { name: 'Routing runs' });
    expect(within(tile('Passed (latest run)')).getByText('43 of 45')).toBeTruthy();
    expect(within(tile('Accuracy')).getByText('95.6%')).toBeTruthy();
    expect(within(tile('Fallback rate')).getByText('15.6%')).toBeTruthy();
    expect(within(tile('Clarify rate')).getByText('6.7%')).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('43 / 45')).toBeTruthy();
    expect(within(rows[0]!).getByText('v3')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const trend = screen.getByRole('region', { name: /per run as a table/ });
    expect(within(trend).getAllByRole('row')).toHaveLength(1 + 4);
    expect(within(trend).getByText('80%')).toBeTruthy();
  });

  it('lets a viewer read but not run or delete', async () => {
    render(<RoutingEvalPanel role="viewer" />);
    await screen.findByRole('region', { name: 'Routing runs' });
    expect(screen.queryByRole('button', { name: 'Run a corpus' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Delete run/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open run Smoke' })).toBeTruthy();
  });
});

describe('the run drawer', () => {
  async function open(name = 'Worked examples') {
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: `Open run ${name}` }));
    return screen.findByRole('dialog', { name: `Routing run: ${name}` });
  }

  it('shows accuracy per field, engines, nodes and failures from the scorecard', async () => {
    const drawer = await open();
    const accuracy = await within(drawer).findByRole('region', { name: 'Accuracy per field' });
    expect(within(accuracy).getAllByText('Not asserted')).toHaveLength(2);
    expect(within(accuracy).getByText('33 cases')).toBeTruthy();
    const engines = within(drawer).getByRole('region', { name: 'Per engine' });
    expect(within(engines).getByText('LLM')).toBeTruthy();
    expect(within(drawer).getByRole('region', { name: 'Per node' })).toBeTruthy();
    const failures = within(drawer).getByRole('region', { name: 'Failures' });
    expect(within(failures).getByText('support-hi-low-confidence')).toBeTruthy();
    expect(within(failures).getByText('status=agent, member=support-hi')).toBeTruthy();
    expect(within(failures).getByText('status=agent, member=support-en')).toBeTruthy();
    expect(within(drawer).getByText('Scripted answers')).toBeTruthy();
  });

  it('shows the confusion matrix as numbers, the diagonal marked right and the rest wrong', async () => {
    const drawer = await open();
    const matrix = await within(drawer).findByRole('region', { name: 'LLM confusion matrix' });
    expect(within(matrix).getByText(/30 of 33 branches chosen correctly/)).toBeTruthy();
    const rows = within(matrix).getAllByRole('row').slice(1);
    const cells = within(rows[0]!).getAllByRole('cell');
    expect(cells.map((cell) => cell.textContent)).toEqual(['18', '1', '0']);
    expect(cells.map((cell) => cell.className)).toEqual(['is-right', 'is-wrong', 'is-zero']);
    expect(cells[0]!.getAttribute('style')).toContain('--cell-tint');
  });

  it('says so when no case asserted a branch and when every case passed', async () => {
    const quiet = evalRun();
    quiet.scorecard = { ...quiet.scorecard, confusion: {}, failures: [], perNode: [] };
    request.mockImplementation(async (path: string) =>
      path.startsWith('/routing/eval-runs?') ? { data: { items: [newer] } } : { data: quiet },
    );
    const drawer = await open();
    expect(await within(drawer).findByText('No case asserted a branch')).toBeTruthy();
    expect(within(drawer).getByText('Every case passed')).toBeTruthy();
    expect(within(drawer).getByText('No node was visited')).toBeTruthy();
  });

  it('shows a loading state, then a failure with Retry', async () => {
    let attempts = 0;
    request.mockImplementation(async (path: string) => {
      if (path.startsWith('/routing/eval-runs?')) return { data: { items: [newer] } };
      attempts += 1;
      if (attempts === 1) throw new ApiError(500, 'boom', 'The scorecard is unreadable');
      return { data: evalRun() };
    });
    const drawer = await open();
    expect(await within(drawer).findByText('The scorecard is unreadable')).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    expect(await within(drawer).findByRole('region', { name: 'Accuracy per field' })).toBeTruthy();
  });

  it('closes from its button', async () => {
    const drawer = await open();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Routing run/ })).toBeNull());
  });
});

describe('deleting a run', () => {
  it('asks first, then deletes and reloads', async () => {
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run Smoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete routing run' });
    expect(within(dialog).getByText(/Delete Smoke and its stored cases/)).toBeTruthy();
    runs = [newer];
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete run' }));
    await waitFor(() => expect(calledWith('DELETE', /\/run-0$/)).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Open run Smoke' })).toBeNull(),
    );
  });

  it('does nothing when cancelled', async () => {
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run Smoke' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete routing run' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(calledWith('DELETE', /./)).toHaveLength(0);
  });

  it('shows why a delete failed and keeps the run', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new ApiError(403, 'forbidden', 'Editors only');
      return base(path, init);
    });
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete run Smoke' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete routing run' })).getByRole('button', {
        name: 'Delete run',
      }),
    );
    expect(await screen.findByText('Editors only')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open run Smoke' })).toBeTruthy();
  });
});
