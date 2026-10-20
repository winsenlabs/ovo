import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTimeline } from '../../lib/derive/call-route';
import { buildHuman, buildTransferRows } from '../../lib/derive/call-route-summary';
import { buildRoutePath } from '../../lib/derive/call-route-path';
import { CALL_START, routedCall, routeEvent, routeSegment } from '../../tests/route-fixtures';
import { polyfillDialog } from '../../tests/inspector-fixtures';
import { RouteChip } from './route-chip';
import { HumanCard } from './route-human-card';
import { RoutePathChips } from './route-path-chips';
import { SegmentDrawer } from './route-segment-drawer';
import { SegmentsTable } from './route-segments-table';
import { SegmentTimeline, timelineRows } from './route-timeline';
import { TransfersTable } from './route-transfers-table';

beforeEach(polyfillDialog);
afterEach(cleanup);

const call = routedCall();
const names = new Map([['agent-sales', 'Sales agent']]);
const timeline = buildTimeline(call, { createdAt: CALL_START, durationMs: 180_000 }, names);

describe('SegmentTimeline', () => {
  it('draws a segment, hold and disclosure mark, each with a name a screen reader can read', () => {
    render(<SegmentTimeline timeline={timeline} />);
    const chart = screen.getByRole('img', {
      name: 'Router, agent and person segments on a shared time axis',
    });
    expect(
      within(chart).getByRole('img', { name: 'Segment 1, Sales agent, 8s to 1m 10s' }),
    ).toBeTruthy();
    expect(within(chart).getByRole('img', { name: 'Transfer 2: caller held 4s' })).toBeTruthy();
    expect(
      within(chart).getByRole('img', { name: /Disclosure played at 1s: Ai, Recording/ }),
    ).toBeTruthy();
    expect(screen.getAllByText('Person')).toHaveLength(2);
  });

  it('offers the same marks as a table', () => {
    render(<SegmentTimeline timeline={timeline} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    const table = screen.getByRole('region', { name: /as a table/ });
    expect(within(table).getByText('#2 agent-billing')).toBeTruthy();
    expect(within(table).getByText('Caller held 21s, Connected')).toBeTruthy();
    expect(within(table).getAllByRole('row')).toHaveLength(1 + timelineRows(timeline).length);
  });

  it('lists marks in time order with the disclosure detail', () => {
    const rows = timelineRows(timeline);
    expect(rows.map((row) => row.kind)).toEqual([
      'Segment',
      'Disclosure',
      'Segment',
      'Hold',
      'Segment',
      'Hold',
      'Segment',
    ]);
    expect(rows[1]).toMatchObject({ what: 'Ai, Recording', detail: 'Played in segment 0' });
  });

  it('says so when there is nothing to draw', () => {
    render(
      <SegmentTimeline
        timeline={buildTimeline({ ...call, segments: [], transfers: [], events: [] }, {})}
      />,
    );
    expect(screen.getByText('No segments recorded')).toBeTruthy();
  });

  it('marks a segment whose end was inferred, and omits lanes and legend entries it does not use', () => {
    const open = buildTimeline(
      { ...call, segments: [routeSegment({ durationMs: null })], transfers: [], events: [] },
      { createdAt: CALL_START, durationMs: 9_000 },
    );
    render(<SegmentTimeline timeline={open} />);
    expect(screen.queryByText('Hold')).toBeNull();
    expect(screen.queryByText('Router')).toBeNull();
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(screen.getByText('Agent, end inferred')).toBeTruthy();
  });
});

describe('RoutePathChips', () => {
  const path = buildRoutePath(call.route, call.events);

  it('reads node, deciding engine, confidence, branch, attempts and the reask that ran', () => {
    render(<RoutePathChips path={path} target="agent" />);
    const trail = screen.getByRole('navigation', { name: 'Route path' });
    const [language, intent] = within(trail).getAllByRole('listitem');
    expect(within(language!).getByText('language')).toBeTruthy();
    expect(within(language!).getByText('Rules · 100%')).toBeTruthy();
    expect(within(intent!).getByText('LLM · 91%')).toBeTruthy();
    expect(within(intent!).getByText('2 attempts')).toBeTruthy();
    expect(within(intent!).getByText('Fallback: Reask taken')).toBeTruthy();
    expect(within(trail).getByText('Agent')).toBeTruthy();
  });

  it('shows an undecided node as the outcome of the last engine asked', () => {
    const undecided = buildRoutePath({ path: ['intent'] }, [
      routeEvent(
        'route.node',
        { turn: 1, node: 'intent', engine: 'external', outcome: 'timeout', ms: 2000 },
        1,
      ),
    ]);
    render(<RoutePathChips path={undecided} target="end" targetNote="Said goodbye" />);
    expect(screen.getByText('External · Timeout')).toBeTruthy();
    expect(screen.getByText('Ended')).toBeTruthy();
    expect(screen.getByText('Said goodbye')).toBeTruthy();
  });

  it('renders nothing for a call with no path and no target', () => {
    const { container } = render(<RoutePathChips path={{ steps: [], loose: [] }} target={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('SegmentsTable', () => {
  it('opens the segment from its number and links the agent to its releases', () => {
    const open = vi.fn();
    render(<SegmentsTable segments={timeline.segments} currency="INR" onOpen={open} />);
    const table = screen.getByRole('region', { name: 'Segments' });
    fireEvent.click(within(table).getByRole('button', { name: 'Open segment 2' }));
    expect(open).toHaveBeenCalledWith(2);
    expect(within(table).getByRole('link', { name: 'Sales agent' }).getAttribute('href')).toBe(
      '/agents/agent-sales/releases',
    );
    expect(within(table).getAllByText('After transfer')).toHaveLength(2);
    expect(within(table).getAllByText('Unpriced')).toHaveLength(1);
  });

  it('says a segment that never reported its end has an unknown duration', () => {
    const open = buildTimeline(
      { ...call, segments: [routeSegment({ durationMs: null, ended: null })], events: [] },
      {},
    );
    render(<SegmentsTable segments={open.segments} currency="INR" onOpen={vi.fn()} />);
    expect(screen.getByText('Unknown')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
  });

  it('has an empty state', () => {
    render(<SegmentsTable segments={[]} currency="INR" onOpen={vi.fn()} />);
    expect(screen.getByText('No segments recorded')).toBeTruthy();
  });
});

describe('TransfersTable', () => {
  it('shows a refusal with its code, and a completed transfer with its timings', () => {
    render(<TransfersTable rows={buildTransferRows(call)} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Refused')).toBeTruthy();
    expect(within(rows[0]!).getByText('no_eligible_member')).toBeTruthy();
    expect(within(rows[0]!).getByText('Not attempted')).toBeTruthy();
    expect(within(rows[1]!).getByText('Accepted')).toBeTruthy();
    expect(within(rows[1]!).getByText('Connected')).toBeTruthy();
    expect(within(rows[1]!).getByText('800 ms')).toBeTruthy();
    expect(within(rows[2]!).getByText('Accepted, queued')).toBeTruthy();
    expect(within(rows[2]!).getByText('Target taken')).toBeTruthy();
  });

  it('marks a request that never completed and a completion with no request', () => {
    const rows = buildTransferRows({
      ...call,
      transfers: [
        {
          requested: { transfer: 1, result: 'accepted', kind: 'queue', key: 'q' },
          completed: null,
        },
        {
          requested: null,
          completed: { transfer: 2, outcome: 'failed', holdMs: 500, reason: 'hold_timeout' },
        },
      ],
    });
    render(<TransfersTable rows={rows} />);
    expect(screen.getByText('Not completed')).toBeTruthy();
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.getByText('Hold timeout')).toBeTruthy();
  });

  it('has an empty state', () => {
    render(<TransfersTable rows={[]} />);
    expect(screen.getByText('No transfers were requested on this call')).toBeTruthy();
  });
});

describe('HumanCard', () => {
  it('shows queue, kind, wait, talk, operator, outcome and callbacks, and no caller details', () => {
    render(<HumanCard human={buildHuman(call)!} />);
    const card = screen.getByRole('region', { name: 'Person' });
    for (const text of ['desk', 'Managed', '19s', '44s', 'u-asha', 'Connected', 'Accepted'])
      expect(within(card).getByText(text)).toBeTruthy();
    expect(card.textContent).not.toMatch(/\+91|ticket-9/);
  });

  it('lists refused requests and shows unknowns as such', () => {
    const response = routedCall();
    response.human = { ...response.human!, waitMs: null, operator: null, outcome: null };
    response.events = [
      routeEvent(
        'human.requested',
        { queue: 'desk', result: 'refused', refusal: 'queue_closed' },
        1,
      ),
    ];
    render(<HumanCard human={buildHuman(response)!} />);
    expect(screen.getByText(/Earlier requests were refused: Queue closed/)).toBeTruthy();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(3);
  });
});

describe('RouteChip', () => {
  it('names the target and the segment count and links to the routing point', () => {
    render(<RouteChip route={call.route!} segments={4} />);
    const chip = screen.getByRole('link', { name: 'Routed to Agent · 4 segments' });
    expect(chip.getAttribute('href')).toBe('/routing/points/point-1');
  });

  it('drops the count for a single segment', () => {
    render(<RouteChip route={{ ...call.route!, target: 'human' }} segments={1} />);
    expect(screen.getByRole('link', { name: 'Routed to Person' })).toBeTruthy();
  });
});

describe('SegmentDrawer', () => {
  const segment = timeline.segments[1]!;
  const props = {
    segment,
    cost: call.segments[1]!.cost,
    events: call.events.filter((event) => event.type === 'segment.ended'),
    lines: [{ id: 'l1', speaker: 'agent' as const, text: 'Namaste, sales here', atMs: 9_000 }],
    callStartMs: Date.parse(CALL_START),
    onClose: vi.fn(),
  };

  it('shows when the segment ran, what it cost, what was said and its events', () => {
    render(<SegmentDrawer {...props} />);
    const drawer = screen.getByRole('dialog', { name: 'Segment 1: Sales agent' });
    expect(within(drawer).getByText('After routing')).toBeTruthy();
    expect(within(drawer).getByText('agent-sales')).toBeTruthy();
    expect(within(drawer).getByText('Estimated')).toBeTruthy();
    expect(within(drawer).getByText('Namaste, sales here')).toBeTruthy();
    expect(within(drawer).getByText('2 routing events')).toBeTruthy();
  });

  it('closes from its button', () => {
    const onClose = vi.fn();
    render(<SegmentDrawer {...props} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('explains a segment with no tagged transcript, no events and no cost', () => {
    render(<SegmentDrawer {...props} cost={null} events={[]} lines={[]} />);
    expect(screen.getByText('No transcript for this segment')).toBeTruthy();
    expect(screen.getByText('No events for this segment')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Cost' })).toBeTruthy();
  });

  it('lists the usage meters the segment reported', () => {
    render(<SegmentDrawer {...props} segment={timeline.segments[0]!} cost={null} />);
    expect(screen.getByText('stt.seconds')).toBeTruthy();
  });

  it('renders nothing while no segment is chosen', () => {
    render(<SegmentDrawer {...props} segment={null} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
