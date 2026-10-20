import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { CALL_START, routedCall } from '../tests/route-fixtures';
import { polyfillDialog } from '../tests/inspector-fixtures';
import { CallInspectorFeature } from './call-inspector';

const request = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
vi.mock('../components/shell/session-provider', () => ({ useSession: () => ({ role: 'admin' }) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/calls/call-routed-1',
}));
beforeEach(() => {
  polyfillDialog();
  nav.params = new URLSearchParams();
});
afterEach(() => {
  cleanup();
  request.mockReset();
});

const tagged = (segment?: number) => (segment === undefined ? {} : { segment });
const line = (id: string, speaker: string, text: string, atMs: number, segment?: number) => ({
  id,
  speaker,
  phase: speaker === 'User' ? 'final' : 'played',
  text,
  atMs,
  ...tagged(segment),
});
const evidence = (segments: (number | undefined)[]) => ({
  call: {
    id: 'call-routed-1',
    agentId: 'agent-router',
    kind: 'simulation',
    status: 'completed',
    createdAt: CALL_START,
    completedAt: '2026-10-20T10:03:00.000Z',
    durationMs: 180_000,
  },
  transcript: [
    line('t0', 'Agent', 'Welcome to Sunrise', 500, segments[0]),
    line('t1', 'User', 'I want a card', 4_000, segments[1]),
    line('t2', 'Agent', 'Sales here', 9_000, segments[2]),
    line('t3', 'Agent', 'Billing speaking', 75_000, segments[3]),
  ],
  events: [],
});

/** Answers the inspector's requests; `segments` is what `/segments` serves (or throws). */
function serve(segments: unknown, body = evidence([0, 0, 1, 2])) {
  request.mockImplementation(async (path: string) => {
    if (path === '/calls/call-routed-1/evidence') return { data: body };
    if (path === '/calls/call-routed-1/segments') {
      if (segments instanceof Error) throw segments;
      return { data: segments };
    }
    if (path === '/agents/agent-router') return { data: { config: { name: 'Front desk' } } };
    if (path === '/agents')
      return {
        data: {
          items: [
            { id: 'agent-sales', config: { name: 'Sales agent' } },
            { id: 'agent-billing', config: { name: 'Billing agent' } },
          ],
        },
      };
    if (path === '/calls/call-routed-1/turns') return { data: { turns: [] } };
    throw new Error(`unexpected ${path}`);
  });
}
const direct = {
  ...routedCall(),
  route: null,
  segments: [],
  transfers: [],
  human: null,
  events: [],
};

describe('the Route & segments tab', () => {
  it('is offered for a routed call and shows its segments by agent name', async () => {
    serve(routedCall());
    render(<CallInspectorFeature callId="call-routed-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Route & segments' }));
    const table = await screen.findByRole('region', { name: 'Segments' });
    await waitFor(() =>
      expect(within(table).getByRole('link', { name: 'Sales agent' })).toBeTruthy(),
    );
    expect(within(table).getByText('Person · desk')).toBeTruthy();
  });

  it('puts a route chip in the header that links to the routing point', async () => {
    serve(routedCall());
    render(<CallInspectorFeature callId="call-routed-1" />);
    const chip = await screen.findByRole('link', { name: 'Routed to Agent · 4 segments' });
    expect(chip.getAttribute('href')).toBe('/routing/points/point-1');
  });

  it('is absent for a direct call, and there is no chip', async () => {
    serve(direct);
    render(<CallInspectorFeature callId="call-routed-1" />);
    await screen.findByRole('heading', { name: 'Front desk call' });
    await waitFor(() => expect(request).toHaveBeenCalledWith('/calls/call-routed-1/segments'));
    expect(screen.queryByRole('tab', { name: 'Route & segments' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Routed to/ })).toBeNull();
  });

  it('explains that routes are not stored when the installation keeps no outcomes', async () => {
    serve({
      callId: 'call-routed-1',
      available: false,
      route: null,
      segments: [],
      transfers: [],
      human: null,
    });
    render(<CallInspectorFeature callId="call-routed-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Route & segments' }));
    expect(await screen.findByText('Route data is not stored here')).toBeTruthy();
  });

  it('is absent when the API has no segments route at all', async () => {
    serve(new ApiError(404, 'not_found', 'Not found'));
    render(<CallInspectorFeature callId="call-routed-1" />);
    await screen.findByRole('heading', { name: 'Front desk call' });
    await waitFor(() => expect(request).toHaveBeenCalledWith('/calls/call-routed-1/segments'));
    expect(screen.queryByRole('tab', { name: 'Route & segments' })).toBeNull();
  });

  it('shows a failure with Retry and leaves the other tabs alone', async () => {
    serve(new ApiError(503, 'unavailable', 'Outcome store is down'));
    render(<CallInspectorFeature callId="call-routed-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Route & segments' }));
    expect(await screen.findByText('Outcome store is down')).toBeTruthy();
    serve(routedCall());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Segments' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Conversation' }));
    expect(await screen.findByText('Welcome to Sunrise')).toBeTruthy();
  });

  it('stays on a tab the URL asked for while the route is still loading', async () => {
    nav.params = new URLSearchParams('tab=route');
    serve(routedCall());
    render(<CallInspectorFeature callId="call-routed-1" />);
    expect(await screen.findByRole('region', { name: 'Segments' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Route & segments', selected: true })).toBeTruthy();
  });

  it('adds the route evidence to Export evidence', async () => {
    serve(routedCall());
    render(<CallInspectorFeature callId="call-routed-1" />);
    await screen.findByRole('link', { name: /Routed to/ });
    const href = screen.getByRole('link', { name: 'Export evidence' }).getAttribute('href')!;
    const exported = JSON.parse(decodeURIComponent(href.split(',')[1]!));
    expect(exported.call.id).toBe('call-routed-1');
    expect(exported.routing.segments).toHaveLength(4);
    expect(exported.routing.route.path).toEqual(['language', 'intent']);
  });

  it('exports plain evidence for a direct call', async () => {
    serve(direct);
    render(<CallInspectorFeature callId="call-routed-1" />);
    await screen.findByRole('heading', { name: 'Front desk call' });
    await waitFor(() => expect(request).toHaveBeenCalledWith('/calls/call-routed-1/segments'));
    const href = screen.getByRole('link', { name: 'Export evidence' }).getAttribute('href')!;
    expect(JSON.parse(decodeURIComponent(href.split(',')[1]!))).not.toHaveProperty('routing');
  });
});

describe('segment dividers in the conversation', () => {
  it('splits a tagged transcript into one block per segment, named', async () => {
    serve(routedCall());
    render(<CallInspectorFeature callId="call-routed-1" />);
    const blocks = await screen.findAllByRole('region', { name: /^Segment \d/ });
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('region', { name: /^Segment \d/ })
          .map((b) => b.getAttribute('aria-label')),
      ).toEqual([
        'Segment 0 - Router, call start',
        'Segment 1 - Sales agent, after routing',
        'Segment 2 - Billing agent, after transfer',
      ]),
    );
    expect(blocks).toHaveLength(3);
    expect(within(blocks[0]!).getByText('Welcome to Sunrise')).toBeTruthy();
    expect(within(blocks[0]!).getByText('I want a card')).toBeTruthy();
    expect(within(blocks[2]!).getByText('Billing speaking')).toBeTruthy();
  });

  it('renders an untagged transcript exactly as before', async () => {
    serve(routedCall(), evidence([undefined, undefined, undefined, undefined]));
    render(<CallInspectorFeature callId="call-routed-1" />);
    expect(await screen.findByText('Welcome to Sunrise')).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^Segment \d/ })).toBeNull();
    expect(screen.queryByRole('heading', { level: 3, name: /^Segment/ })).toBeNull();
  });

  it('labels dividers by number alone while the route is unavailable', async () => {
    serve(new ApiError(503, 'unavailable', 'down'));
    render(<CallInspectorFeature callId="call-routed-1" />);
    expect(await screen.findByRole('region', { name: 'Segment 1' })).toBeTruthy();
  });
});
