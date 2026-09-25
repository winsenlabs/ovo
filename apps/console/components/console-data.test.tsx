import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCursorList } from '../lib/data/use-cursor-list';
import { useEventStream } from '../lib/data/use-event-stream';
import { DataTable } from './ui/data-table';
import { describeError } from '../lib/errors';

const nav = vi.hoisted(() => ({ search: '', pushes: [] as string[] }));
const request = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  usePathname: () => '/agents',
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({
    push: (url: string) => {
      nav.pushes.push(url);
      nav.search = url.split('?')[1] ?? '';
    },
  }),
}));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));

class FakeEventSource {
  static sources: FakeEventSource[] = [];
  readonly url: string;
  onmessage?: (event: MessageEvent) => void;
  onopen?: () => void;
  onerror?: () => void;
  listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.sources.push(this);
  }
  addEventListener(name: string, handler: EventListener) {
    this.listeners.set(name, [
      ...(this.listeners.get(name) ?? []),
      handler as (event: MessageEvent) => void,
    ]);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown, id = '') {
    const event = { data: JSON.stringify(data), lastEventId: id } as MessageEvent;
    if (name === 'message') this.onmessage?.(event);
    else this.listeners.get(name)?.forEach((handler) => handler(event));
  }
}

beforeEach(() => {
  nav.search = '';
  nav.pushes = [];
  request.mockReset();
  FakeEventSource.sources = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('console data surfaces', () => {
  function Pages() {
    const page = useCursorList<{ id: string }>('/agents?status=active', 50);
    return (
      <>
        <span data-testid="ids">{page.items.map((item) => item.id).join(',')}</span>
        <span data-testid="state">{page.status}</span>
        <button disabled={!page.hasNext} onClick={page.next}>
          Next page
        </button>
        <button disabled={!page.hasPrevious} onClick={page.previous}>
          Previous page
        </button>
      </>
    );
  }

  it('fetches cursor pages and keeps next and previous in the URL', async () => {
    request.mockImplementation(async (path: string) => ({
      data: path.includes('cursor=page-2')
        ? { items: [{ id: 'second' }] }
        : { items: [{ id: 'first' }], nextCursor: 'page-2' },
    }));
    const view = render(<Pages />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('first'));
    expect(request).toHaveBeenCalledWith('/agents?status=active&limit=50');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(nav.pushes.at(-1)).toBe('/agents?cursor=page-2');
    view.rerender(<Pages />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('second'));
    expect(request).toHaveBeenCalledWith('/agents?status=active&limit=50&cursor=page-2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(nav.pushes.at(-1)).toBe('/agents');
    view.rerender(<Pages />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('first'));
  });

  it('reports a failed list without presenting stale rows as a successful page', async () => {
    request.mockRejectedValue(new Error('API unavailable'));
    render(<Pages />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    expect(screen.getByTestId('ids').textContent).toBe('');
  });

  it('clears a successful page when the next cursor request fails', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.includes('cursor=page-2')) throw new Error('Next page unavailable');
      return { data: { items: [{ id: 'first' }], nextCursor: 'page-2' } };
    });
    const view = render(<Pages />);
    await waitFor(() => expect(screen.getByTestId('ids').textContent).toBe('first'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    view.rerender(<Pages />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    expect(screen.getByTestId('ids').textContent).toBe('');
  });

  it('ignores an old page response after a newer cursor request fails', async () => {
    let finishOld!: (value: { data: { items: { id: string }[] } }) => void;
    request.mockImplementation((path: string) =>
      path.includes('cursor=page-2')
        ? Promise.reject(new Error('Next page unavailable'))
        : new Promise((resolve) => {
            finishOld = resolve;
          }),
    );
    const view = render(<Pages />);
    nav.search = 'cursor=page-2';
    view.rerender(<Pages />);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('error'));
    await act(async () => {
      finishOld({ data: { items: [{ id: 'old-row' }] } });
    });
    expect(screen.getByTestId('state').textContent).toBe('error');
    expect(screen.getByTestId('ids').textContent).toBe('');
  });

  function Stream() {
    const state = useEventStream<{ text?: string }>('/api/v1/calls/call-1/stream', 1000);
    return (
      <>
        <span data-testid="stream-status">{state.status}</span>
        <span data-testid="stream-events">{state.events.map((event) => event.text).join(',')}</span>
      </>
    );
  }

  it('deduplicates the replay cursor and reconnects from the last event', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    render(<Stream />);
    const first = FakeEventSource.sources[0]!;
    expect(first.url).toBe('/api/v1/calls/call-1/stream');
    act(() => {
      first.onopen?.();
      first.emit('transcript', { text: 'hello' }, '7');
      first.emit('transcript', { text: 'hello' }, '7');
    });
    expect(screen.getByTestId('stream-events').textContent).toBe('hello');
    act(() => {
      first.onerror?.();
    });
    expect(first.closed).toBe(true);
    expect(screen.getByTestId('stream-status').textContent).toBe('stale');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(FakeEventSource.sources[1]?.url).toBe('/api/v1/calls/call-1/stream?cursor=7');
  });

  it('starts a new call without the previous call cursor or transcript', () => {
    vi.stubGlobal('EventSource', FakeEventSource);
    function CallStream({ callId }: { callId: string }) {
      const state = useEventStream<{ text: string }>(`/api/v1/calls/${callId}/stream`, 1000);
      return (
        <>
          <span data-testid="stream-status">{state.status}</span>
          <span data-testid="stream-events">
            {state.events.map((event) => event.text).join(',')}
          </span>
        </>
      );
    }
    const view = render(<CallStream callId="call-A" />);
    const first = FakeEventSource.sources[0]!;
    act(() => {
      first.onopen?.();
      first.emit('transcript', { text: 'A transcript' }, 'event-A');
    });
    expect(screen.getByTestId('stream-events').textContent).toBe('A transcript');

    view.rerender(<CallStream callId="call-B" />);
    expect(first.closed).toBe(true);
    const second = FakeEventSource.sources[1]!;
    expect(second.url).toBe('/api/v1/calls/call-B/stream');
    expect(screen.getByTestId('stream-events').textContent).toBe('');
    expect(screen.getByTestId('stream-status').textContent).toBe('connecting');
    act(() => {
      first.emit('transcript', { text: 'late A transcript' }, 'late-A');
      second.emit('transcript', { text: 'B transcript' }, 'event-B');
    });
    expect(screen.getByTestId('stream-events').textContent).toBe('B transcript');
  });

  it('uses heartbeat liveness and closes the stream on unmount', () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeEventSource);
    const view = render(<Stream />);
    const source = FakeEventSource.sources[0]!;
    act(() => {
      source.onopen?.();
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('stream-status').textContent).toBe('stale');
    act(() => {
      source.emit('heartbeat', {});
    });
    expect(screen.getByTestId('stream-status').textContent).toBe('live');
    view.unmount();
    expect(source.closed).toBe(true);
  });

  it('renders table headers as mobile card labels and an honest empty state', () => {
    const columns = [{ id: 'id', header: 'Agent', cell: (row: { id: string }) => row.id }];
    const view = render(
      <DataTable label="Agents" rows={[{ id: 'a1' }]} columns={columns} rowKey={(row) => row.id} />,
    );
    expect(screen.getByRole('region', { name: 'Agents' })).toBeDefined();
    expect(screen.getByRole('columnheader', { name: 'Agent' })).toBeDefined();
    expect(screen.getByRole('cell').getAttribute('data-label')).toBe('Agent');
    view.rerender(
      <DataTable
        label="Agents"
        rows={[]}
        columns={columns}
        rowKey={(row) => row.id}
        empty="No agents returned"
      />,
    );
    expect(screen.getByText('No agents returned')).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('describes API errors without leaking an object string', () => {
    expect(describeError(new Error('Offline'))).toContain('Offline');
    expect(describeError({ code: 'bad_request', message: 'Invalid field' })).not.toContain(
      '[object Object]',
    );
  });
});
