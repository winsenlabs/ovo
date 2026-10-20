import type { Inference } from '@winsendotai/ovo-contracts';
import { describe, expect, it } from 'vitest';
import { TRANSFER_BUILT_IN_LINES } from '@winsendotai/ovo-contracts';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '../src/testing.ts';
import { dtmf, NIGHT, silence, simulate, speech, trace } from './support-sim.ts';
import { deskSnapshot, DESK_ID, OFFICE } from './support-human.ts';

const llm = (over: Record<string, unknown> = {}) => ({
  node: 'intent',
  engine: 'llm' as const,
  ...over,
});
const chain = (fallback: unknown[], more?: (raw: Record<string, any>) => void) =>
  exampleRoutingSnapshot((raw) => {
    raw.nodes[0].fallback = fallback;
    more?.(raw);
  });

/** A chain whose default step is the full Sales pool: it fails, so the release default is reached. */
const salesFull = {
  fullMembers: ['sales-en', 'sales-hi', 'sales-ta'].map((memberId) => ({
    poolId: I.salesPool,
    memberId,
  })),
};
const salesDefault = [
  { kind: 'reask', times: 1 },
  { kind: 'default', target: { kind: 'pool', poolId: I.salesPool, language: 'any' } },
];

describe('simulateRoute: fallback chains', () => {
  it('re-asks once, then takes the default step', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('umm'), speech('not sure')],
      engines: { answers: [llm({ branch: 'sales', confidence: 0.1, repeat: true })] },
    });
    expect(trace(run).filter((line) => line.startsWith('fallback'))).toEqual([
      'fallback:reask:taken',
      'fallback:default:taken',
    ]);
    expect(run.turns[1]!.say).toBe('Is it about buying something new, or an existing account?');
    expect(run.outcome).toMatchObject({ status: 'agent', agent: { agentId: 'sales-en' } });
  });

  it('exhausts the chain into the release default', async () => {
    const run = await simulate(chain(salesDefault), {
      turns: [speech('umm'), speech('hmm')],
      faults: salesFull,
    });
    expect(trace(run).filter((line) => line.startsWith('fallback'))).toEqual([
      'fallback:reask:taken',
      'fallback:default:failed(pool_full)',
      'fallback:release_default:taken',
    ]);
    expect(run.outcome).toMatchObject({ status: 'agent', agent: { releaseId: I.salesEn } });
  });

  it('ends with the built-in goodbye when even the release default cannot be prepared', async () => {
    const run = await simulate(chain(salesDefault), {
      turns: [speech('umm'), speech('hmm')],
      faults: { ...salesFull, failedReleases: [{ releaseId: I.salesEn }] },
    });
    expect(trace(run)).toContain('fallback:release_default:failed(compose_failed)');
    expect(run.outcome).toMatchObject({
      status: 'end',
      degraded: 'release_default_failed',
      completionReason: 'route:end:intent',
    });
    expect(run.outcome.line).toMatch(/^Sorry, I could not connect your call right now/);
  });

  it('ends with the authored line and its disposition', async () => {
    const run = await simulate(
      chain([{ kind: 'end', line: { en: 'Goodbye.' } }], (raw) => {
        raw.nodes[0].branches[0].target = {
          kind: 'end',
          line: { en: 'Closed.' },
          disposition: 'after_hours',
        };
      }),
      { turns: [dtmf('1')] },
    );
    expect(run.outcome).toMatchObject({
      status: 'end',
      line: 'Closed.',
      endDisposition: 'after_hours',
    });
    expect(run.turns[1]!.steps.map((s) => s.type)).toEqual([
      'route.node',
      'route.decision',
      'disposition',
    ]);
  });

  it('promises a callback and names the release to dial back', async () => {
    const run = await simulate(
      chain([{ kind: 'callback', inMinutes: 30, line: { en: 'We will call you back.' } }]),
      { turns: [speech('umm')] },
    );
    expect(run.outcome).toMatchObject({
      status: 'callback',
      callback: { inMinutes: 30, releaseId: I.salesEn },
      line: 'We will call you back.',
    });
    const disposition = run.turns[1]!.steps.find((s) => s.type === 'disposition');
    expect(disposition?.payload.callback).toMatchObject({
      dueAt: '2026-10-15T07:00:03.000Z',
      timezone: 'Asia/Kolkata',
    });
  });
});

describe('simulateRoute: limits, silence and undecided routes', () => {
  it('takes the release default once the turn limit is passed', async () => {
    const run = await simulate(
      exampleRoutingSnapshot((raw) => {
        raw.limits = { maxTurns: 1, maxRouteSeconds: 90 };
      }),
      { turns: [speech('a'), speech('b'), speech('c')] },
    );
    expect(trace(run)).toContain('fallback:limit:taken(max_turns)');
    expect(run.outcome.status).toBe('agent');
    expect(run.warnings.map((w) => w.code)).toContain('turns_unused');
  });

  it('takes the release default once the route time is passed, silence costing the idle timeout', async () => {
    const run = await simulate(
      exampleRoutingSnapshot((raw) => {
        raw.limits = { maxTurns: 20, maxRouteSeconds: 10 };
      }),
      { turns: [silence, silence] },
    );
    expect(run.turns.map((t) => t.virtualMs)).toEqual([0, 8000, 16000]);
    expect(run.turns.map((t) => t.say)).toEqual([
      'Welcome to Acme. How can I help you today?',
      'Are you still there?',
      'Connecting you now.',
    ]);
    expect(trace(run)).toContain('fallback:limit:taken(max_route_seconds)');
  });

  it('plays the idle prompts, then the re-ask, for a silent caller', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [silence, silence] });
    expect(run.turns.map((t) => t.say)).toEqual([
      'Welcome to Acme. How can I help you today?',
      'Are you still there?',
      'Is it about buying something new, or an existing account?',
    ]);
    expect(run.outcome.status).toBe('undecided');
  });

  it('reports undecided, at the node it is waiting on, when the turns run out', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [dtmf('2')] });
    expect(run.outcome).toMatchObject({
      status: 'undecided',
      completionReason: null,
      node: 'product',
      path: ['intent', 'product'],
      context: { intent: 'support' },
      turns: 1,
      agent: null,
      line: 'Is it about a card or a loan?',
    });
    expect(run.turns.at(-1)!.phase).toBe('routing');
    // The product node's classifier has no scripted answer, and says so.
    expect(run.warnings).toEqual([
      expect.objectContaining({ code: 'engine_unscripted', node: 'product' }),
    ]);
  });

  it('with no caller turns, stops after the greeting', async () => {
    const run = await simulate(exampleRoutingSnapshot());
    expect(run.turns).toHaveLength(1);
    expect(run.outcome).toMatchObject({
      status: 'undecided',
      node: 'intent',
      turns: 0,
      routeMs: 0,
    });
  });

  it('counts the caller turns left over after the route was decided', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [dtmf('1'), speech('a'), speech('b')],
    });
    expect(run.turns).toHaveLength(2);
    expect(run.warnings).toEqual([
      expect.objectContaining({
        code: 'turns_unused',
        message: expect.stringContaining('2 caller turn'),
      }),
    ]);
  });

  it('answers two nodes from one utterance when the second reuses the turn', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [speech('my card')],
      engines: { answers: [llm({ branch: 'support', confidence: 0.9 })] },
    });
    expect(run.outcome.path).toEqual(['intent', 'product']);
    expect(run.turns).toHaveLength(2);
    expect(run.outcome).toMatchObject({ status: 'agent', agent: { memberId: 'support-cards' } });
  });
});

describe('simulateRoute: pools', () => {
  const sales = { fullMembers: [{ poolId: I.salesPool, memberId: 'sales-en' }] };

  it('explains why a full pool refused, and the chain moves on', async () => {
    const run = await simulate(exampleRoutingSnapshot(), { turns: [dtmf('1')], faults: sales });
    expect(run.pools).toHaveLength(1);
    expect(run.pools[0]).toMatchObject({
      poolName: 'Sales',
      turn: 1,
      node: 'intent',
      result: 'pool_full',
    });
    expect(run.pools[0]!.members.find((m) => m.memberId === 'sales-en')).toMatchObject({
      eligible: true,
      full: true,
      picked: false,
      reasons: ['fault'],
    });
    expect(trace(run)).toContain('fallback:default:taken');
    expect(run.outcome.agent).toMatchObject({ agentId: 'sales-en', releaseId: I.salesEn });
    expect(run.outcome.agent).not.toHaveProperty('poolId');
  });

  it('queues the caller on hold when transfers are on and the point waits for capacity', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.schemaVersion = 2;
      raw.transfer = {
        hold: {
          steps: [{ kind: 'silence', seconds: 3 }],
          waitForCapacity: true,
          onTimeout: [{ kind: 'default' }],
        },
      };
    });
    const run = await simulate(
      snapshot,
      { turns: [dtmf('1')], faults: sales },
      {
        flags: { transferEnabled: true, humanQueueEnabled: true },
      },
    );
    expect(run.outcome).toMatchObject({
      status: 'queue',
      completionReason: 'route:agent:intent',
      agent: null,
    });
    expect(run.pools[0]!.result).toBe('queued');
    expect(run.turns[1]!.say).toBe(TRANSFER_BUILT_IN_LINES.queue.en);
  });

  it('counts a member whose load reaches its capacity as full', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.pools[I.salesPool].members[0].capacity = 2;
    });
    const busy = await simulate(
      snapshot,
      { turns: [dtmf('1')] },
      { load: { [`${I.salesPool}:sales-en`]: 2 } },
    );
    expect(busy.pools[0]!.members[0]).toMatchObject({ active: 2, capacity: 2, full: true });
    expect(busy.pools[0]!.result).toBe('pool_full');
    const room = await simulate(
      snapshot,
      { turns: [dtmf('1')] },
      { load: { [`${I.salesPool}:sales-en`]: 1 } },
    );
    expect(room.pools[0]).toMatchObject({ result: 'picked' });
    expect(room.outcome.agent?.memberId).toBe('sales-en');
  });

  it('falls back to the pool language fallback when the Tamil office is closed', async () => {
    const ask = (at: string) =>
      simulate(exampleRoutingSnapshot(), {
        call: { at },
        turns: [speech('naya card')],
        engines: { answers: [llm({ branch: 'sales', confidence: 0.9, language: 'ta' })] },
      });
    const open = await ask(new Date(Date.UTC(2026, 9, 15, 6, 30)).toISOString());
    expect(open.outcome.agent?.memberId).toBe('sales-ta');
    expect(open.pools[0]).toMatchObject({ languageUsed: 'ta' });
    const closed = await ask(new Date(NIGHT).toISOString());
    expect(closed.outcome.agent?.memberId).toBe('sales-en');
    expect(closed.pools[0]).toMatchObject({
      languageUsed: 'en',
      wanted: { language: 'ta', languageMode: 'caller' },
    });
    expect(closed.pools[0]!.members.find((m) => m.memberId === 'sales-ta')).toMatchObject({
      open: false,
      eligible: false,
      reasons: ['closed', 'language'],
    });
  });

  it('reads member hours on the member wall clock across a daylight-saving change', async () => {
    // New York leaves daylight time on 2026-11-01: 13:30 UTC is 09:30 EDT the day before, 08:30 EST after.
    const snapshot = exampleRoutingSnapshot((raw) => {
      const week = Object.fromEntries(
        ['sat', 'sun', 'fri'].map((d) => [d, [{ start: '09:00', end: '17:00' }]]),
      );
      raw.pools[I.salesPool].members[2].hours = { timezone: 'America/New_York', weekly: week };
    });
    const ask = (at: string) =>
      simulate(snapshot, {
        call: { at },
        turns: [speech('card')],
        engines: { answers: [llm({ branch: 'sales', confidence: 0.9, language: 'ta' })] },
      });
    expect((await ask('2026-10-31T13:30:00Z')).outcome.agent?.memberId).toBe('sales-ta');
    expect((await ask('2026-11-01T13:30:00Z')).outcome.agent?.memberId).toBe('sales-en');
    expect((await ask('2026-11-01T14:30:00Z')).outcome.agent?.memberId).toBe('sales-ta');
  });

  it('fails a release the faults name and moves the chain on', async () => {
    const run = await simulate(exampleRoutingSnapshot(), {
      turns: [dtmf('1')],
      faults: { failedReleases: [{ releaseId: I.salesEn, reason: 'timeout' }] },
    });
    expect(trace(run).filter((line) => line.startsWith('fallback'))).toEqual([
      'fallback:reask:skipped(timeout)',
      'fallback:default:failed(timeout)',
      'fallback:end:taken',
    ]);
    expect(run.outcome.status).toBe('end');
  });
});

describe('simulateRoute: warnings and writes', () => {
  it('warns that a transfer catalogue is not run', async () => {
    const snapshot = exampleRoutingSnapshot((raw) => {
      raw.schemaVersion = 2;
      raw.transfer = {
        targets: [
          {
            key: 'billing',
            description: 'Billing questions',
            destination: {
              kind: 'agent',
              agent: { agentId: 'sales-en', release: { kind: 'pinned', releaseId: I.salesEn } },
            },
          },
        ],
      };
    });
    const run = await simulate(snapshot);
    expect(run.warnings.map((w) => w.code)).toEqual(['transfer_not_simulated']);
  });

  it('stops at the wall-clock guard with what the router had decided so far', async () => {
    const never: Inference = { model: 'stuck', generate: () => new Promise(() => undefined) };
    const run = await simulate(
      exampleRoutingSnapshot(),
      { turns: [speech('a card')], engines: { mode: { llm: 'live' } } },
      { guardMs: 20, live: { inference: never } },
    );
    expect(run.warnings.map((w) => w.code)).toEqual(['live_engine_used', 'simulation_aborted']);
    expect(run.outcome).toMatchObject({ status: 'undecided', turns: 1 });
    expect(run.turns).toHaveLength(1);
  });
});
