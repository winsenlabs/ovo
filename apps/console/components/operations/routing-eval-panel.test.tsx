import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { evalRun, evalSummary } from '../../tests/routing-eval-fixtures';
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
  request.mockImplementation(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path.startsWith('/routing/eval-runs?')) {
      if (listFailure) throw listFailure;
      return { data: { items: runs, nextCursor: null } };
    }
    if (path === '/routing/eval-runs' && method === 'POST')
      return { data: evalRun({ id: 'run-new', name: JSON.parse(String(init?.body)).name }) };
    if (path.startsWith('/routing/eval-runs/') && method === 'DELETE') return { data: undefined };
    if (path.startsWith('/routing/eval-runs/'))
      return { data: evalRun({ id: path.split('/').pop()! }) };
    if (path.startsWith('/routing/points?'))
      return { data: { items: [{ id: 'point-1', draft: { name: 'Main line' } }] } };
    if (path.includes('/releases?'))
      return {
        data: {
          items: [
            { id: 'rr-3', version: 3 },
            { id: 'rr-2', version: 2 },
          ],
        },
      };
    throw new Error(`unexpected ${method} ${path}`);
  });
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

describe('running a corpus', () => {
  async function openForm() {
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a corpus' }));
    const dialog = screen.getByRole('dialog', { name: 'Run a corpus' });
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: 'Main line · v3' })).toBeTruthy(),
    );
    return dialog;
  }
  const paste = (dialog: HTMLElement, text: string) =>
    fireEvent.change(within(dialog).getByLabelText(/^Corpus/), { target: { value: text } });
  const submit = (dialog: HTMLElement) =>
    within(dialog).getByRole('button', { name: 'Run corpus' }) as HTMLButtonElement;

  it('lists the releases of every routing point, warns not to paste real callers', async () => {
    const dialog = await openForm();
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Main line · v3', 'Main line · v2']);
    expect(within(dialog).getByText(/Do not paste real caller data/)).toBeTruthy();
    expect(submit(dialog).disabled).toBe(true);
  });

  it('names the first failing case before anything is sent', async () => {
    const dialog = await openForm();
    paste(
      dialog,
      JSON.stringify([validCase('first'), { ...validCase('second'), expect: { status: 'maybe' } }]),
    );
    expect(
      within(dialog).getByText(/Case 2 \(second\): expect\.status must be one of agent/),
    ).toBeTruthy();
    expect(submit(dialog).disabled).toBe(true);
    fireEvent.click(submit(dialog));
    expect(calledWith('POST', /./)).toHaveLength(0);
  });

  it('posts a valid JSONL corpus against the chosen release, then opens the run', async () => {
    const dialog = await openForm();
    paste(dialog, [validCase('a'), validCase('b')].map((c) => JSON.stringify(c)).join('\n'));
    expect(within(dialog).getByText('2 cases are valid.')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Routing release'), {
      target: { value: 'rr-2' },
    });
    fireEvent.change(within(dialog).getByLabelText('Run name'), {
      target: { value: ' Hindi sales ' },
    });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Assume human queues are on' }));
    expect(submit(dialog).disabled).toBe(false);
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(calledWith('POST', /^\/routing\/eval-runs$/)).toHaveLength(1));
    const body = JSON.parse(String(calledWith('POST', /./)[0]![1].body));
    expect(body).toMatchObject({
      routingReleaseId: 'rr-2',
      name: 'Hindi sales',
      assume: { transferEnabled: false, humanQueueEnabled: true },
    });
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    expect(await screen.findByRole('dialog', { name: 'Routing run: Hindi sales' })).toBeTruthy();
  });

  it('reads an uploaded file', async () => {
    const dialog = await openForm();
    const file = new File([JSON.stringify([validCase('from-file')])], 'corpus.json', {
      type: 'application/json',
    });
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve(JSON.stringify([validCase('from-file')])),
    });
    fireEvent.change(
      within(dialog).getByLabelText('Drop a .json or .jsonl corpus, or choose a file'),
      {
        target: { files: [file] },
      },
    );
    expect(await within(dialog).findByText('1 cases are valid.')).toBeTruthy();
  });

  it('shows the server refusal with the case it names, and stays open', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        throw new ApiError(422, 'routing_eval_case_invalid', 'node is not in the release', {
          index: 1,
        });
      return base(path, init);
    });
    const dialog = await openForm();
    paste(dialog, JSON.stringify([validCase('a'), validCase('b')]));
    fireEvent.click(submit(dialog));
    expect(await within(dialog).findByText('Case 2: node is not in the release')).toBeTruthy();
    expect(submit(dialog).disabled).toBe(false);
  });

  it('warns when there is no published release to score', async () => {
    const base = request.getMockImplementation()!;
    request.mockImplementation(async (path: string, init?: RequestInit) =>
      path.includes('/releases?') ? { data: { items: [] } } : base(path, init),
    );
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a corpus' }));
    expect(await screen.findByText(/no published routing release/)).toBeTruthy();
  });

  it('retries when the releases cannot be loaded', async () => {
    const base = request.getMockImplementation()!;
    let failing = true;
    request.mockImplementation(async (path: string, init?: RequestInit) => {
      if (failing && path.startsWith('/routing/points?'))
        throw new ApiError(503, 'unavailable', 'Releases are down');
      return base(path, init);
    });
    render(<RoutingEvalPanel role="editor" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run a corpus' }));
    expect(await screen.findByText('Releases are down')).toBeTruthy();
    failing = false;
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Run a corpus' })).getByRole('button', {
        name: 'Retry',
      }),
    );
    expect(await screen.findByRole('option', { name: 'Main line · v3' })).toBeTruthy();
  });

  it('is not offered to a viewer', async () => {
    render(<RoutingEvalPanel role="viewer" />);
    await screen.findByRole('region', { name: 'Routing runs' });
    expect(screen.queryByRole('dialog', { name: 'Run a corpus' })).toBeNull();
  });
});
