import { describe, expect, it } from 'vitest';
import { routedCall, routeEvent } from '../../tests/route-fixtures';
import { buildRoutePath, dividerLabel, groupBySegment, segmentOf } from './call-route-path';

describe('the route path', () => {
  it('shows the deciding engine and confidence of each node, and the reask that ran at one', () => {
    const { route, events } = routedCall();
    const { steps, loose } = buildRoutePath(route, events);
    expect(
      steps.map((s) => [s.node, s.engine, s.outcome, s.branch, s.confidence, s.attempts]),
    ).toEqual([
      ['language', 'rules', 'matched', 'hi', 1, 1],
      ['intent', 'llm', 'matched', 'sales', 0.91, 2],
    ]);
    expect(steps[1]!.decided).toBe(true);
    expect(steps[1]!.fallbacks).toEqual([
      { node: 'intent', step: 'reask', result: 'taken', attempt: 1, reason: null },
    ]);
    expect(loose).toEqual([]);
  });

  it('shows the last engine asked, undecided, for a node nothing matched', () => {
    const events = [
      routeEvent(
        'route.node',
        { turn: 1, node: 'intent', engine: 'llm', outcome: 'no_match', ms: 300 },
        1,
      ),
      routeEvent(
        'route.node',
        {
          turn: 1,
          node: 'intent',
          engine: 'external',
          outcome: 'timeout',
          reason: 'timeout',
          ms: 2000,
        },
        2,
      ),
      routeEvent(
        'route.fallback',
        {
          turn: 1,
          node: 'intent',
          step: 'default',
          result: 'taken',
          attempt: 1,
          reason: 'pool_full',
        },
        3,
      ),
    ];
    const [step] = buildRoutePath({ path: ['intent'] }, events).steps;
    expect([step!.engine, step!.outcome, step!.decided, step!.reason]).toEqual([
      'external',
      'timeout',
      false,
      'timeout',
    ]);
    expect(step!.fallbacks[0]).toMatchObject({ step: 'default', reason: 'pool_full' });
  });

  it('reads the nodes from the events when the decision recorded no path', () => {
    const events = [
      routeEvent(
        'route.node',
        { turn: 0, node: 'a', engine: 'rules', outcome: 'matched', branch: 'x' },
        1,
      ),
      routeEvent(
        'route.node',
        { turn: 1, node: 'b', engine: 'llm', outcome: 'matched', branch: 'y', confidence: 0.8 },
        2,
      ),
      routeEvent(
        'route.node',
        { turn: 2, node: 'a', engine: 'rules', outcome: 'matched', branch: 'x' },
        3,
      ),
    ];
    expect(buildRoutePath(null, events).steps.map((s) => s.node)).toEqual(['a', 'b']);
    expect(buildRoutePath({ path: [] }, events).steps.map((s) => s.node)).toEqual(['a', 'b']);
  });

  it('keeps a fallback at a node outside the path as a loose step', () => {
    const events = [
      routeEvent(
        'route.fallback',
        { turn: 5, node: 'ghost', step: 'end', result: 'failed', attempt: 2 },
        1,
      ),
    ];
    const path = buildRoutePath({ path: ['intent'] }, events);
    expect(path.loose).toEqual([
      { node: 'ghost', step: 'end', result: 'failed', attempt: 2, reason: null },
    ]);
    expect(path.steps[0]).toMatchObject({
      node: 'intent',
      engine: null,
      attempts: 0,
      decided: false,
    });
  });

  it('is empty without a route or events', () => {
    expect(buildRoutePath(null, [])).toEqual({ steps: [], loose: [] });
  });
});

describe('transcript segments', () => {
  it.each([
    [{ segment: 2 }, 2],
    [{ segment: 0 }, 0],
    [{ segment: -1 }, null],
    [{ segment: 1.5 }, null],
    [{ segment: '2' }, null],
    [{}, null],
    [null, null],
  ])('reads the tag of %j as %j', (entry, expected) => {
    expect(segmentOf(entry)).toBe(expected);
  });

  it.each([
    [
      'an untagged call stays one group',
      ['a', 'b', 'c'],
      [null, null, null],
      [[null, ['a', 'b', 'c']]],
    ],
    [
      'one block per segment',
      ['a', 'b', 'c', 'd'],
      [0, 0, 1, 2],
      [
        [0, ['a', 'b']],
        [1, ['c']],
        [2, ['d']],
      ],
    ],
    [
      'an untagged line joins the segment before it',
      ['a', 'b', 'c'],
      [0, null, 1],
      [
        [0, ['a', 'b']],
        [1, ['c']],
      ],
    ],
    ['a leading untagged line takes the first tag', ['a', 'b'], [null, 1], [[1, ['a', 'b']]]],
    [
      'a segment that returns opens a new block',
      ['a', 'b', 'c'],
      [0, 1, 0],
      [
        [0, ['a']],
        [1, ['b']],
        [0, ['c']],
      ],
    ],
    ['no lines, no groups to render', [], [], [[null, []]]],
  ])('groups: %s', (_name, items, tags, expected) => {
    const groups = groupBySegment(items, tags as (number | null)[]);
    expect(groups.map((g) => [g.segment, g.items])).toEqual(expected);
  });

  it('labels a divider with the segment, its agent and why it started', () => {
    const { segments } = routedCall();
    const names = new Map([['agent-billing', 'Billing agent']]);
    expect(dividerLabel(2, segments, names)).toBe('Segment 2 - Billing agent, after transfer');
    expect(dividerLabel(0, segments)).toBe('Segment 0 - Router, call start');
    expect(dividerLabel(3, segments)).toBe('Segment 3 - Person · desk, after transfer');
    expect(dividerLabel(9, segments)).toBe('Segment 9');
  });
});
