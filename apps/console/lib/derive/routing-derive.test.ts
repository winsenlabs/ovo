import { ROUTING_ISSUE_CODES } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { anchorIssue as routingIssueAnchor, indexIssues, issuesAt } from './routing-issue-index';
import { clientIssues, friendlyMessage, mergeIssues } from './routing-issues';
import { lineRows } from './routing-lines';
import { bindConsequence, isBehind, numbersOfPoint } from './routing-numbers';
import { poolFacts, hoursSummary } from './routing-pools';
import { queueReadiness, queueUsage } from './routing-queues';
import { sampleDraft } from './routing-support.test-helpers';
import { blankDraft, loadDraft } from './routing-defaults';
import { statsKpis, pointStates } from './routing-overview';
import { targetLine, pathItems, takenFallbacks } from './routing-path';
import { deepestFallback } from './routing-simulate';

describe('routingIssueAnchor', () => {
  const d = sampleDraft();
  it('places node, branch, engine and fallback issues on their node', () => {
    expect(routingIssueAnchor(d, { path: ['nodes', 0, 'branches', 1, 'next'] })).toMatchObject({
      section: 'branch',
      nodeId: 'intent',
      branchKey: 'support',
      field: 'next',
    });
    expect(
      routingIssueAnchor(d, { path: ['nodes', 1, 'engines', 0, 'rules', 0, 'branch'] }),
    ).toMatchObject({ section: 'engine', nodeId: 'support_kind', engineIndex: 0 });
    expect(routingIssueAnchor(d, { path: ['nodes', 0, 'fallback', 2] })).toMatchObject({
      section: 'fallback',
      stepIndex: 2,
    });
    expect(routingIssueAnchor(d, { path: ['nodes', 0, 'ask'] })).toMatchObject({
      section: 'node',
      field: 'ask',
    });
  });
  it('places the rest by tab', () => {
    expect(routingIssueAnchor(d, { path: ['language', 'allowed'] }).section).toBe('languages');
    expect(routingIssueAnchor(d, { path: ['greeting', 'en'] }).section).toBe('lines');
    expect(routingIssueAnchor(d, { path: ['router'] }).section).toBe('agents');
    expect(routingIssueAnchor(d, { path: ['humanQueues', 0, 'key'] })).toMatchObject({
      section: 'queues',
      queueKey: 'desk',
    });
    expect(routingIssueAnchor(d, { path: ['transfer', 'targets', 0, 'key'] })).toMatchObject({
      section: 'transfer',
      targetKey: 'billing',
    });
    expect(routingIssueAnchor(d, { path: ['transfer', 'hold', 'onTimeout'] }).section).toBe('hold');
    expect(routingIssueAnchor(d, { path: ['limits'] }).section).toBe('limits');
    expect(routingIssueAnchor(d, { path: ['root'] }).section).toBe('point');
  });
  it('anchors every issue code the server can send without throwing', () => {
    for (const code of ROUTING_ISSUE_CODES)
      expect(() =>
        indexIssues(d, [{ code, severity: 'error', path: ['nodes', 0], message: code }]),
      ).not.toThrow();
  });
  it('indexes counts and per-node issues', () => {
    const index = indexIssues(d, [
      { code: 'a', severity: 'error', path: ['nodes', 0, 'ask'], message: 'x' },
      { code: 'b', severity: 'warning', path: ['nodes', 0, 'branches', 0, 'key'], message: 'y' },
    ]);
    expect([index.errors, index.warnings]).toEqual([1, 1]);
    expect(issuesAt(index, 'intent', 'branch', { branchKey: 'sales' })).toHaveLength(1);
    expect(issuesAt(index, 'support_kind', 'node')).toHaveLength(0);
  });
});

describe('client issues', () => {
  it('is empty for a valid draft and flags structure and schema problems', () => {
    expect(clientIssues(sampleDraft())).toEqual([]);
    const broken = sampleDraft();
    broken.nodes[0]!.fallback = [{ kind: 'reask', times: 1 }];
    broken.greeting = { hi: 'namaste' };
    const codes = clientIssues(broken).map((i) => i.code);
    expect(codes).toContain('routing_fallback_not_terminal');
    expect(codes).toContain('routing_line_default_missing');
    const schema = sampleDraft();
    schema.nodes[0]!.id = 'Bad Id';
    expect(clientIssues(schema).some((i) => i.code === 'schema')).toBe(true);
  });
  it('merges without repeating and words schema messages plainly', () => {
    const a = { code: 'x', severity: 'error' as const, path: ['a'], message: 'm' };
    expect(mergeIssues([a], [a, { ...a, code: 'y' }]).map((i) => i.code)).toEqual(['x', 'y']);
    expect(
      friendlyMessage({ code: 'too_small', origin: 'array', minimum: 1, path: [], message: '' }),
    ).toBe('Needs at least 1 item(s)');
    expect(friendlyMessage({ code: 'invalid_type', input: undefined, path: [], message: '' })).toBe(
      'Required',
    );
  });
});

describe('lines, pools, numbers, queues', () => {
  it('audits every line for the default language', () => {
    const d = sampleDraft();
    d.nodes[0]!.ask = { hi: 'namaste' };
    const rows = lineRows(d);
    expect(rows.find((r) => r.label === 'Question on intent')).toMatchObject({
      missingDefault: true,
    });
    expect(rows.find((r) => r.label === 'Greeting')).toMatchObject({ missingDefault: false });
    expect(rows.some((r) => r.label.startsWith('Transfer target billing'))).toBe(true);
  });
  it('summarises hours and pool facts', () => {
    expect(hoursSummary(undefined)).toBe('Always open');
    expect(
      hoursSummary({
        timezone: 'Asia/Kolkata',
        weekly: {
          mon: [{ start: '09:00', end: '18:00' }],
          tue: [{ start: '09:00', end: '18:00' }],
        },
        closed: [],
      }),
    ).toBe('Mon-Tue 09:00-18:00 (Asia/Kolkata)');
    expect(
      poolFacts({
        name: 'p',
        languageFallback: [],
        members: [
          {
            id: 'a',
            agent: { agentId: 'x', release: { kind: 'latest' } },
            languages: ['hi', 'en'],
            products: [],
            skills: [],
            priority: 50,
            enabled: true,
            capacity: 5,
          },
        ],
      }),
    ).toMatchObject({ members: 1, languages: ['en', 'hi'], capacity: 5 });
  });
  it('knows which numbers are behind and what binding does', () => {
    const row = {
      phoneNumber: '+9180',
      version: 1,
      enabled: true,
      releaseId: null,
      routingReleaseId: 'r',
      routing: { pointId: 'p', pointName: 'Main', version: 2 },
      carrierPluginId: null,
      carrierBindingId: null,
      variables: {},
    };
    const releases = [
      { id: 'r3', version: 3, digest: '', draftVersion: 3, createdAt: '', createdBy: '' },
    ];
    expect(isBehind(row, releases)).toBe(true);
    expect(isBehind({ ...row, routing: { ...row.routing, version: 3 } }, releases)).toBe(false);
    expect(
      numbersOfPoint([row, { ...row, routing: null, routingReleaseId: null }], 'p'),
    ).toHaveLength(1);
    expect(bindConsequence(row, 'Main', 3)).toMatchObject({
      needsConfirm: false,
      text: expect.stringContaining('moves'),
    });
    expect(bindConsequence(row, 'Main', 1).text).toContain('rolls the number back');
    expect(
      bindConsequence({ ...row, routing: null, routingReleaseId: null, releaseId: 'x' }, 'Main', 3)
        .needsConfirm,
    ).toBe(true);
  });
  it('finds queue usage and readiness', () => {
    const d = sampleDraft();
    expect(queueUsage(d).get('desk')).toEqual(['intent > person']);
    const record = {
      id: 'q',
      version: 1,
      definition: { kind: 'managed' as const },
      stats: { online: 0, waiting: 0, offered: 0, oldestWaitMs: 0, handled24h: 0 },
      usedBy: [],
      updatedAt: '',
    } as never;
    const status = {
      enabled: true,
      webhookEnabled: true,
      managedAvailable: true,
      room: { configured: true },
    };
    expect(queueReadiness(record, status).label).toBe('No operators online');
    expect(queueReadiness(undefined, status).tone).toBe('danger');
    expect(queueReadiness(record, { ...status, enabled: false }).label).toBe(
      'Human queues are off',
    );
  });
});

describe('defaults and overview', () => {
  it('a blank draft is valid with no issues', () => {
    const d = blankDraft({ name: 'x', routerAgentId: 'a', defaultAgentId: 'b' });
    expect(clientIssues(d)).toEqual([]);
    expect(loadDraft(d).valid).toBe(true);
    expect(loadDraft({ nope: true }).valid).toBe(false);
  });
  it('KPIs are unknown when outcomes are not stored', () => {
    expect(statsKpis({ available: false } as never)).toEqual({
      routed: null,
      fallbackRate: null,
      reachedPerson: null,
      p50: null,
      p95: null,
    });
    const totals = {
      routed: 200,
      withFallback: 10,
      reachedPerson: 7,
      routeMsP50: 5000,
      routeMsP95: 9000,
    };
    expect(statsKpis({ available: true, totals } as never)).toMatchObject({
      routed: 200,
      fallbackRate: 5,
    });
  });
  it('badges drafts, published releases and unpublished changes', () => {
    const point = {
      draftVersion: 4,
      summary: { latestRelease: { version: 3 }, published: false },
    } as never;
    expect(pointStates(point).map((s) => s.label)).toEqual([
      'Draft v4',
      'Published v3',
      'Unpublished changes',
    ]);
    expect(
      pointStates({
        draftVersion: 1,
        summary: { latestRelease: null, published: false },
      } as never).map((s) => s.label),
    ).toContain('Never published');
  });
});

describe('simulation path', () => {
  const result = {
    outcome: {
      status: 'agent',
      agent: { agentId: 'a1', releaseId: 'r', memberId: 'm' },
      path: ['intent'],
      line: '',
      degraded: null,
    },
    turns: [
      { index: 0, input: { kind: 'opening' }, say: '', phase: 'routing', virtualMs: 0, steps: [] },
      {
        index: 1,
        input: { kind: 'speech', text: 'x' },
        say: '',
        phase: 'ended',
        virtualMs: 3000,
        steps: [
          {
            type: 'route.node',
            mocked: false,
            payload: { node: 'intent', engine: 'rules', outcome: 'no_match' },
          },
          {
            type: 'route.node',
            mocked: true,
            payload: {
              node: 'intent',
              engine: 'llm',
              outcome: 'matched',
              branch: 'sales',
              confidence: 0.9,
            },
          },
          {
            type: 'route.fallback',
            payload: { node: 'intent', step: 'reask', result: 'taken', attempt: 1 },
          },
          {
            type: 'route.fallback',
            payload: { node: 'intent', step: 'default', result: 'taken', attempt: 1 },
          },
        ],
      },
    ],
  } as never;
  it('chains questions with their attempts and finds the deepest fallback', () => {
    const items = pathItems(result);
    expect(items[0]).toMatchObject({ kind: 'node', node: 'intent', chosen: 'sales' });
    expect(items).toHaveLength(3);
    expect(deepestFallback(result)).toBe('default');
    expect(takenFallbacks(result)).toBe(1);
    expect(targetLine(result)).toBe('Agent a1 (member m)');
  });
});
