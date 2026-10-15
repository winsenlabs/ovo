import { describe, expect, it } from 'vitest';
import { RoutingEngineError } from '@winsendotai/ovo-contracts';
import { createExternalRunner } from '../src/engines/index.ts';
import { fakeRoutingHost } from '../src/testing.ts';
import { engineInput, engineNode, engineOf, forever } from './support.ts';

const externalNode = (over: Record<string, unknown> = {}) =>
  engineNode([
    {
      kind: 'external',
      endpoint: 'https://decide.example.com/route',
      credentialId: 'route-hmac',
      timeoutMs: 100,
      threshold: 0.5,
      slots: ['product'],
      ...over,
    },
  ]);
const turn = { text: 'my card is blocked' };

async function decide(answer: () => unknown, over: Record<string, unknown> = {}) {
  const host = fakeRoutingHost({ external: answer as never });
  const node = externalNode(over);
  const result = await createExternalRunner(host)(
    engineOf(node, 'external'),
    engineInput(node, turn),
  );
  return { result, host };
}

describe('external engine: answers', () => {
  it.each<[string, unknown, Record<string, unknown>]>([
    [
      'a known branch matches',
      { branch: 'support', confidence: 0.8 },
      { outcome: 'matched', branch: 'support', confidence: 0.8 },
    ],
    ['confidence defaults to 1', { branch: 'support' }, { outcome: 'matched', confidence: 1 }],
    [
      'under the threshold is low confidence',
      { branch: 'support', confidence: 0.2 },
      { outcome: 'low_confidence', branch: 'support' },
    ],
    [
      'a null branch is no match',
      { branch: null },
      { outcome: 'no_match', reason: 'external_no_branch' },
    ],
    [
      'a branch the node lacks is refused',
      { branch: 'billing', confidence: 1 },
      { outcome: 'error', reason: 'unknown_branch' },
    ],
    ['a malformed body is invalid', { branch: 7 }, { outcome: 'error', reason: 'invalid' }],
    [
      'a slot value outside the key grammar is invalid',
      { branch: 'support', slots: { product: 'Cards!' } },
      { outcome: 'error', reason: 'invalid' },
    ],
  ])('%s', async (_name, body, expected) => {
    expect((await decide(() => body)).result).toMatchObject(expected);
  });

  it('keeps only the slots in the engine allow-list', async () => {
    const { result } = await decide(() => ({
      branch: 'support',
      slots: { product: 'cards', tier: 'gold' },
    }));
    expect(result.slots).toEqual({ product: 'cards' });
    const none = await decide(() => ({ branch: 'support', slots: { tier: 'gold' } }));
    expect(none.result.slots).toBeUndefined();
  });
});

describe('external engine: host errors', () => {
  it.each<[string, RoutingEngineError | Error, Record<string, unknown>]>([
    ['timeout', new RoutingEngineError('timeout', 'deadline'), { outcome: 'timeout' }],
    [
      'disabled',
      new RoutingEngineError('disabled', 'OVO_ROUTING_EXTERNAL_ENABLED is off'),
      { outcome: 'disabled', reason: 'external_disabled' },
    ],
    [
      'transport with a code',
      new RoutingEngineError('transport', 'http_503'),
      { outcome: 'error', reason: 'http_503' },
    ],
    [
      'transport with prose',
      new RoutingEngineError('transport', 'connect ECONNREFUSED 10.0.0.1:443'),
      { outcome: 'error', reason: 'transport' },
    ],
    [
      'invalid',
      new RoutingEngineError('invalid', 'oversize'),
      { outcome: 'error', reason: 'oversize' },
    ],
    ['anything else', new Error('boom'), { outcome: 'error', reason: 'external_failed' }],
  ])('maps %s', async (_name, error, expected) => {
    const { result } = await decide(() => {
      throw error;
    });
    expect(result).toEqual(expected);
  });

  it('bounds a host that never answers', async () => {
    const { result } = await decide(() => forever());
    expect(result).toEqual({ outcome: 'timeout' });
  });
});

describe('external engine: what the host is given', () => {
  it('passes the node, branches, context and the turn when turnText is on', async () => {
    const { host } = await decide(() => ({ branch: 'sales' }));
    expect(host.externals).toEqual([
      expect.objectContaining({
        node: 'intent',
        branches: ['sales', 'support'],
        context: { values: {} },
        turn: { text: 'my card is blocked' },
      }),
    ]);
    expect(host.externals[0]!.engine.credentialId).toBe('route-hmac');
  });

  it('withholds the turn when turnText is off', async () => {
    const { host } = await decide(() => ({ branch: 'sales' }), {
      send: { turnText: false, callerId: false, variables: [] },
    });
    expect(host.externals[0]).not.toHaveProperty('turn');
  });
});
