import { describe, expect, it } from 'vitest';
import { RoutingNode, type RoutingTarget } from '@winsendotai/ovo-contracts';
import { RouteRecorder } from '../src/events.ts';
import { runFallback, type FallbackResult } from '../src/fallback.ts';
import type { FallbackCursor } from '../src/state.ts';
import type { Attempt } from '../src/targets.ts';

const DEFAULT_AGENT: RoutingTarget = {
  kind: 'agent',
  agent: {
    agentId: 'sales-en',
    release: { kind: 'pinned', releaseId: '00000000-0000-4000-8000-0000000000b1' },
  },
};
const end = { en: 'Goodbye.' };

function chain(
  fallback: unknown[],
  ask: Record<string, string> | null = { en: 'Sales or support?' },
) {
  return RoutingNode.parse({
    id: 'intent',
    ...(ask ? { ask } : {}),
    engines: [{ kind: 'llm', instructions: 'Route.' }],
    branches: [{ key: 'sales', description: 'sales', target: { kind: 'end', line: end } }],
    fallback,
  });
}

/** Targets resolve unless their kind (or a pool's id) is listed as failing, with that reason. */
function attempts(failing: Record<string, string> = {}) {
  const tried: string[] = [];
  const attempt = async (target: RoutingTarget): Promise<Attempt> => {
    const key = target.kind === 'pool' ? `pool:${target.poolId}` : target.kind;
    tried.push(key);
    if (failing[key]) return { ok: false, reason: failing[key]! };
    if (target.kind === 'agent' || target.kind === 'pool')
      return {
        ok: true,
        resolution: { kind: 'agent', agentId: key, releaseId: 'r', handoffId: 'h' },
      };
    if (target.kind === 'human') return { ok: false, reason: 'human_queue_unavailable' };
    if (target.kind === 'callback')
      return {
        ok: true,
        resolution: {
          kind: 'callback',
          line: 'Later.',
          inMinutes: 120,
          agentId: 'a',
          releaseId: 'r',
        },
      };
    return { ok: true, resolution: { kind: 'end', line: target.line.en! } };
  };
  return { tried, attempt };
}

async function run(
  node: RoutingNode,
  cursor: FallbackCursor,
  options: { failing?: Record<string, string>; noReask?: string; clarify?: string } = {},
) {
  const recorder = new RouteRecorder();
  const { tried, attempt } = attempts(options.failing);
  const result: FallbackResult = await runFallback({
    node,
    cursor,
    turn: 2,
    recorder,
    ...(options.noReask ? { noReask: options.noReask } : {}),
    reaskLine: (step) => options.clarify ?? step.line?.en ?? node.ask?.en,
    defaultTarget: DEFAULT_AGENT,
    finalLine: 'Built-in goodbye.',
    attempt,
  });
  return { result, events: recorder.events.map((event) => event.payload), tried, cursor };
}

const ev = (step: string, result: string, attempt = 1, reason?: string) => ({
  turn: 2,
  node: 'intent',
  step,
  result,
  attempt,
  ...(reason ? { reason } : {}),
});
const POOL = '00000000-0000-4000-8000-0000000000d1';

describe('runFallback', () => {
  it.each<
    [string, unknown[], { failing?: Record<string, string>; noReask?: string }, unknown, unknown[]]
  >([
    [
      'reask speaks the node ask',
      [{ kind: 'reask' }, { kind: 'end', line: end }],
      {},
      { kind: 'reask', line: 'Sales or support?' },
      [ev('reask', 'taken')],
    ],
    [
      'reask speaks its own line',
      [
        { kind: 'reask', line: { en: 'Once more?' } },
        { kind: 'end', line: end },
      ],
      {},
      { kind: 'reask', line: 'Once more?' },
      [ev('reask', 'taken')],
    ],
    [
      'default without a target is the release default agent',
      [{ kind: 'default' }],
      {},
      { kind: 'resolved', resolution: { kind: 'agent', agentId: 'agent' } },
      [ev('default', 'taken')],
    ],
    [
      'default with a pool target',
      [{ kind: 'default', target: { kind: 'pool', poolId: POOL } }],
      {},
      { kind: 'resolved', resolution: { agentId: `pool:${POOL}` } },
      [ev('default', 'taken')],
    ],
    [
      'a full pool moves on to the end',
      [
        { kind: 'default', target: { kind: 'pool', poolId: POOL } },
        { kind: 'end', line: end },
      ],
      { failing: { [`pool:${POOL}`]: 'pool_full' } },
      { kind: 'resolved', resolution: { kind: 'end', line: 'Goodbye.' } },
      [ev('default', 'failed', 1, 'pool_full'), ev('end', 'taken')],
    ],
    [
      'human is skipped in R1, then callback',
      [
        { kind: 'human', queueId: 'desk' },
        { kind: 'callback', line: { en: 'Later.' } },
      ],
      {},
      { kind: 'resolved', resolution: { kind: 'callback' } },
      [ev('human', 'skipped', 1, 'human_queue_unavailable'), ev('callback', 'taken')],
    ],
    [
      'a failed target skips the re-asks',
      [
        { kind: 'reask', times: 2 },
        { kind: 'end', line: end },
      ],
      { noReask: 'pool_full' },
      { kind: 'resolved', resolution: { kind: 'end' } },
      [ev('reask', 'skipped', 1, 'pool_full'), ev('end', 'taken')],
    ],
    [
      'exhaustion falls to the release default',
      [{ kind: 'default', target: { kind: 'pool', poolId: POOL } }],
      { failing: { [`pool:${POOL}`]: 'no_eligible_member' } },
      { kind: 'resolved', resolution: { kind: 'agent', agentId: 'agent' } },
      [ev('default', 'failed', 1, 'no_eligible_member'), ev('release_default', 'taken')],
    ],
    [
      'a release default that fails ends with the built-in line',
      [{ kind: 'default' }],
      { failing: { agent: 'compose_failed' } },
      {
        kind: 'resolved',
        resolution: { kind: 'end', line: 'Built-in goodbye.', degraded: 'release_default_failed' },
      },
      [
        ev('default', 'failed', 1, 'compose_failed'),
        ev('release_default', 'failed', 1, 'compose_failed'),
      ],
    ],
  ])('%s', async (_name, fallback, options, result, events) => {
    const outcome = await run(chain(fallback), { index: 0, reasks: 0 }, options);
    expect(outcome.result).toMatchObject(result as object);
    expect(outcome.events).toEqual(events);
  });

  it('re-asks up to `times`, one per call, then resumes past it', async () => {
    const node = chain([{ kind: 'reask', times: 2 }, { kind: 'default' }]);
    const cursor = { index: 0, reasks: 0 };
    const first = await run(node, cursor);
    const second = await run(node, cursor);
    const third = await run(node, cursor);
    expect([first.result.kind, second.result.kind, third.result.kind]).toEqual([
      'reask',
      'reask',
      'resolved',
    ]);
    expect([...first.events, ...second.events, ...third.events]).toEqual([
      ev('reask', 'taken', 1),
      ev('reask', 'taken', 2),
      ev('default', 'taken'),
    ]);
  });

  it('resumes after a failed default instead of trying it again', async () => {
    const node = chain([
      { kind: 'reask' },
      { kind: 'default', target: { kind: 'pool', poolId: POOL } },
      { kind: 'reask' },
      { kind: 'end', line: end },
    ]);
    const cursor = { index: 0, reasks: 0 };
    await run(node, cursor);
    const second = await run(node, cursor, { failing: { [`pool:${POOL}`]: 'pool_full' } });
    expect(second.result).toEqual({ kind: 'reask', line: 'Sales or support?' });
    const third = await run(node, cursor);
    expect(third.tried).toEqual(['end']);
    expect(third.events).toEqual([ev('end', 'taken')]);
  });

  it('prefers a generated clarifying question for a re-ask', async () => {
    const outcome = await run(
      chain([{ kind: 'reask' }, { kind: 'end', line: end }]),
      { index: 0, reasks: 0 },
      { clarify: 'A new card, or your current one?' },
    );
    expect(outcome.result).toEqual({ kind: 'reask', line: 'A new card, or your current one?' });
  });

  it('skips a re-ask with no line to say', async () => {
    const outcome = await run(chain([{ kind: 'reask' }, { kind: 'end', line: end }], null), {
      index: 0,
      reasks: 0,
    });
    expect(outcome.events).toEqual([ev('reask', 'skipped', 1, 'no_line'), ev('end', 'taken')]);
  });

  it('goes straight to the release default once the chain is spent', async () => {
    const outcome = await run(chain([{ kind: 'reask' }]), { index: 1, reasks: 0 });
    expect(outcome.result).toMatchObject({ kind: 'resolved', resolution: { kind: 'agent' } });
    expect(outcome.events).toEqual([ev('release_default', 'taken')]);
  });
});
