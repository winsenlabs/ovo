import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { evalSummary, routingEvalApiMock } from '../../tests/routing-eval-fixtures';
import { polyfillDialog } from '../../tests/inspector-fixtures';
import { RoutingEvalPanel } from './routing-eval-panel';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

beforeEach(() => {
  polyfillDialog();
  request.mockImplementation(
    routingEvalApiMock({ runs: () => [evalSummary()], listFailure: () => undefined }),
  );
});
afterEach(() => {
  cleanup();
  request.mockReset();
});

const calledWith = (method: string, path: RegExp) =>
  request.mock.calls.filter(([p, i]) => (i?.method ?? 'GET') === method && path.test(p));

const validCase = (id: string) => ({
  id,
  call: {},
  turns: [{ kind: 'dtmf', digits: '1' }],
  expect: { status: 'agent' },
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
      assume: { humanQueueEnabled: true },
    });
    // The switch left alone is not sent: the server's own flag applies.
    expect(body.assume).not.toHaveProperty('transferEnabled');
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual(['a', 'b']);
    expect(await screen.findByRole('dialog', { name: 'Routing run: Hindi sales' })).toBeTruthy();
  });

  it('sends no assumptions at all when neither switch was touched', async () => {
    const dialog = await openForm();
    paste(dialog, JSON.stringify([validCase('a')]));
    fireEvent.click(submit(dialog));
    await waitFor(() => expect(calledWith('POST', /^\/routing\/eval-runs$/)).toHaveLength(1));
    expect(JSON.parse(String(calledWith('POST', /./)[0]![1].body))).not.toHaveProperty('assume');
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
