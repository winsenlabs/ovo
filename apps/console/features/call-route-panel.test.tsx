import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { routeTabVisible, type CallRouteState } from '../lib/data/call-route-api';
import type { CallEvidence } from '../lib/derive/call-detail';
import { CALL_START, routedCall } from '../tests/route-fixtures';
import { polyfillDialog } from '../tests/inspector-fixtures';
import { CallRoutePanel, routeEvidence } from './call-route-panel';

const nav = vi.hoisted(() => ({ params: new URLSearchParams(), replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  useRouter: () => ({ replace: nav.replace }),
  usePathname: () => '/calls/call-routed-1',
}));
beforeEach(() => {
  polyfillDialog();
  nav.params = new URLSearchParams('tab=route');
  nav.replace.mockReset();
});
afterEach(cleanup);

const evidence: CallEvidence = {
  call: { id: 'call-routed-1', createdAt: CALL_START, durationMs: 180_000, kind: 'live' },
  transcript: [
    {
      id: 't0',
      speaker: 'Agent',
      phase: 'played',
      text: 'Welcome to Sunrise',
      atMs: 500,
      segment: 0,
    } as never,
    {
      id: 't1',
      speaker: 'User',
      phase: 'final',
      text: 'I want a card',
      atMs: 4_000,
      segment: 0,
    } as never,
    {
      id: 't2',
      speaker: 'Agent',
      phase: 'played',
      text: 'Sales here, how can I help',
      atMs: 9_000,
      segment: 1,
    } as never,
    {
      id: 't3',
      speaker: 'Agent',
      phase: 'played',
      text: 'Billing speaking',
      atMs: 75_000,
      segment: 2,
    } as never,
  ],
};
const names = new Map([
  ['agent-sales', 'Sales agent'],
  ['agent-billing', 'Billing agent'],
]);
const ready = (data = routedCall()): CallRouteState & { refresh: () => void } => ({
  status: 'ready',
  data,
  refresh: vi.fn(),
});
/** The KPI tile with this label (a table can carry the same word as its title). */
const tile = (label: string) =>
  screen
    .getAllByText(label)
    .find((element) => element.classList.contains('ds-kpi-label'))!
    .closest('article')!;
const panel = (route: CallRouteState & { refresh: () => void }) =>
  render(<CallRoutePanel route={route} evidence={evidence} names={names} />);

describe('route and segments states', () => {
  it('shows skeletons while loading', () => {
    panel({ status: 'loading', refresh: vi.fn() });
    expect(screen.getAllByRole('status', { name: /Loading/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('region', { name: 'Segments' })).toBeNull();
  });

  it('keeps the page and offers Retry when the route cannot be loaded', () => {
    const refresh = vi.fn();
    panel({ status: 'error', error: new Error('The API is down'), refresh });
    expect(screen.getByRole('alert').textContent).toContain('The API is down');
    expect(
      screen.getByText(/other tabs? are unaffected|latency and cost tabs are unaffected/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('says the route was not stored when outcomes are not kept', () => {
    panel(
      ready({
        ...routedCall(),
        available: false,
        route: null,
        segments: [],
        transfers: [],
        events: [],
      }),
    );
    expect(screen.getByText('Route data is not stored here')).toBeTruthy();
    expect(screen.getByText(/PostgreSQL only/)).toBeTruthy();
  });

  it('says a direct call was not routed', () => {
    panel(
      ready({ ...routedCall(), route: null, segments: [], transfers: [], human: null, events: [] }),
    );
    expect(screen.getByText('This call was not routed')).toBeTruthy();
  });
});

describe('a routed call', () => {
  it('summarises the route in the KPI strip', () => {
    panel(ready());
    const strip = tile;
    expect(within(strip('Route target')).getByText('Agent')).toBeTruthy();
    expect(within(strip('Segments')).getByText('4')).toBeTruthy();
    expect(within(strip('Transfers')).getByText('1 refused · 2 connected')).toBeTruthy();
    expect(within(strip('Hold total')).getByText('25s')).toBeTruthy();
    expect(within(strip('Person wait')).getByText('19s')).toBeTruthy();
    expect(within(strip('Cost, all segments')).getByText(/15\.30/)).toBeTruthy();
    expect(within(strip('Cost, all segments')).getByText('Includes call-level usage')).toBeTruthy();
  });

  it('shows the timeline, the route taken, the segments, the transfers and the person', () => {
    panel(ready());
    expect(screen.getByRole('heading', { name: 'Segment timeline' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Route path' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Segments' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Transfers' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Person' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Billing agent' })).toBeTruthy();
  });

  it('explains a degraded route and a missing person', () => {
    const data = routedCall();
    data.route = { ...data.route!, degraded: 'router_compose_failed' };
    data.human = null;
    data.segments = data.segments.slice(0, 3);
    panel(ready(data));
    expect(screen.getByText('Degraded: Router compose failed')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Person' })).toBeNull();
  });

  it('tells the reader when the events were cut', () => {
    panel(ready({ ...routedCall(), eventsTruncated: true }));
    expect(screen.getByText(/Showing the first 400 events/)).toBeTruthy();
  });

  it('shows unknown, not zero, for a call with no hold, wait or cost', () => {
    const data = routedCall();
    data.transfers = [];
    data.human = null;
    data.callLevelCost = null;
    data.segments = data.segments.map((segment) => ({ ...segment, cost: null }));
    panel(ready(data));
    for (const label of ['Hold total', 'Person wait', 'Cost, all segments'])
      expect(within(tile(label)).getByTitle('Unknown')).toBeTruthy();
  });
});

describe('the segment drawer deep link', () => {
  it('opens the segment named by ?segment= with only its transcript lines', () => {
    nav.params = new URLSearchParams('tab=route&segment=1');
    panel(ready());
    const drawer = screen.getByRole('dialog', { name: 'Segment 1: Sales agent' });
    expect(within(drawer).getByText('Sales here, how can I help')).toBeTruthy();
    expect(within(drawer).queryByText('Welcome to Sunrise')).toBeNull();
    expect(within(drawer).queryByText('Billing speaking')).toBeNull();
  });

  it.each(['', 'abc', '-1', '9', '1.5'])('ignores ?segment=%s', (value) => {
    nav.params = new URLSearchParams(`tab=route&segment=${value}`);
    panel(ready());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('writes the segment to the URL when a row is opened, keeping the tab', () => {
    panel(ready());
    fireEvent.click(screen.getByRole('button', { name: 'Open segment 2' }));
    expect(nav.replace).toHaveBeenCalledWith('/calls/call-routed-1?tab=route&segment=2', {
      scroll: false,
    });
  });

  it('drops the segment from the URL when the drawer closes', () => {
    nav.params = new URLSearchParams('tab=route&segment=2');
    panel(ready());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(nav.replace).toHaveBeenCalledWith('/calls/call-routed-1?tab=route', { scroll: false });
  });
});

describe('tab visibility and export', () => {
  const failed = (status: number): CallRouteState => ({
    status: 'error',
    error: new ApiError(status, 'x', 'x'),
  });
  it.each([
    ['loading, not asked for', { status: 'loading' } as CallRouteState, false, false],
    ['loading, asked for by the URL', { status: 'loading' } as CallRouteState, true, true],
    ['an API without the route (404)', failed(404), false, false],
    ['a failing API (503)', failed(503), false, true],
    ['a plain error', { status: 'error', error: new Error('boom') } as CallRouteState, false, true],
    ['a routed call', { status: 'ready', data: routedCall() } as CallRouteState, false, true],
    [
      'outcomes not stored',
      {
        status: 'ready',
        data: { ...routedCall(), available: false, route: null, segments: [] },
      } as CallRouteState,
      false,
      true,
    ],
    [
      'a direct call',
      { status: 'ready', data: { ...routedCall(), route: null, segments: [] } } as CallRouteState,
      false,
      false,
    ],
  ])('%s', (_name, route, selected, visible) => {
    expect(routeTabVisible(route, selected)).toBe(visible);
  });

  it('adds the route evidence for a routed call only', () => {
    const exported = routeEvidence({ status: 'ready', data: routedCall() });
    expect(Object.keys(exported.routing!).sort()).toEqual([
      'callLevelCost',
      'events',
      'eventsTruncated',
      'human',
      'route',
      'segments',
      'transfers',
    ]);
    expect(routeEvidence({ status: 'loading' })).toEqual({});
    expect(
      routeEvidence({ status: 'ready', data: { ...routedCall(), route: null, segments: [] } }),
    ).toEqual({});
  });
});
