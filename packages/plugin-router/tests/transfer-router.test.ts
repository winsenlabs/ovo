import { describe, expect, it } from 'vitest';
import { AgentConfig, type MemberClaim, type RouterEntry } from '@winsendotai/ovo-contracts';
import { parseRouterConfig } from '../src/index.ts';
import { exampleRoutingSnapshot, EXAMPLE_IDS as I } from '../src/testing.ts';
import { dtmf, opening, routerHarness } from './harness.ts';

const GREETING = 'Welcome to Acme. How can I help you today?';
const RECORDED = 'This call is recorded.';
const AI = 'You are speaking with an AI assistant.';
const disclosure = [
  { kind: 'ai' as const, text: AI },
  { kind: 'recording' as const, text: RECORDED },
];
const full = (): MemberClaim => ({ kind: 'full' });
const waitForCapacity = (raw: Record<string, any>) => {
  raw.schemaVersion = 2;
  raw.transfer = {
    hold: {
      steps: [{ kind: 'silence', seconds: 3 }],
      waitForCapacity: true,
      onTimeout: [{ kind: 'default' }],
    },
  };
};
const entry = (over: Partial<RouterEntry> = {}): RouterEntry => ({
  node: 'product',
  path: ['intent'],
  context: { values: { intent: 'support' } },
  disclosed: [],
  transfer: 1,
  ...over,
});

describe('router handoff: begin when the host offers it, else prepare', () => {
  it('asks prepare, never begin, on an R1 host', async () => {
    const h = routerHarness();
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.handoff.prepared).toHaveLength(1);
    expect(h.handoff.begun).toEqual([]);
    expect(h.handoff.committed).toEqual(['handoff-1']);
  });

  it('begins, commits the begun handoff and says the connecting line', async () => {
    const h = routerHarness({ handoff: { begin: true } });
    await h.turn('', opening);
    expect((await h.turn('1', dtmf('1'))).say).toBe('Connecting you now.');
    expect(h.handoff.prepared).toEqual([]);
    expect(h.handoff.begun[0]).toMatchObject({ kind: 'agent', reason: 'route' });
    expect(h.handoff.begun[0]).not.toHaveProperty('transfer');
    expect(h.handoff.committed).toEqual(['begin-1']);
    expect(h.core.phase).toBe('announcing');
  });

  it('queues a full pool only with begin and the point waiting for capacity', async () => {
    const queued = routerHarness({
      patch: waitForCapacity,
      host: { claim: full },
      handoff: { begin: true },
    });
    await queued.turn('', opening);
    expect((await queued.turn('1', dtmf('1'))).say).toBe(
      'All our colleagues are busy right now. Please hold and you will be connected shortly.',
    );
    expect(queued.handoff.begun.map((request) => request.kind)).toEqual(['queue']);
    expect(queued.handoff.committed).toEqual(['begin-1']);
    expect(queued.of('route.decision')[0]).not.toHaveProperty('agentId');

    // The same point on an R1 host: no queue, the full pool fails as before.
    const r1 = routerHarness({ patch: waitForCapacity, host: { claim: full } });
    await r1.turn('', opening);
    await r1.turn('1', dtmf('1'));
    expect(r1.of('route.fallback')[0]).toMatchObject({ step: 'reask', reason: 'pool_full' });
    expect(r1.handoff.prepared.map((request) => request.kind)).toEqual(['agent']);
  });

  it('says the queue line in the caller language', async () => {
    const h = routerHarness({
      patch: waitForCapacity,
      host: { claim: full },
      handoff: { begin: true },
      script: { intent: { llm: [{ outcome: 'matched', branch: 'sales', language: 'hi' }] } },
    });
    await h.turn('', opening);
    expect((await h.turn('naya card')).say).toBe(
      'अभी सभी सहयोगी व्यस्त हैं। कृपया होल्ड करें, आपको जल्द ही जोड़ा जाएगा।',
    );
    expect(h.handoff.begun[0]).toMatchObject({
      kind: 'queue',
      poolId: I.salesPool,
      variables: { ovo_route_language: 'hi' },
    });
  });

  it('a queue begin refusal fails the target with its reason and the chain moves on', async () => {
    const h = routerHarness({
      patch: waitForCapacity,
      host: { claim: full },
      handoff: {
        begin: (request) =>
          request.kind === 'queue'
            ? { ok: false, reason: 'segments_exhausted' }
            : { ok: true, handoffId: 'default', state: 'ready' },
      },
    });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.of('route.fallback')[0]).toMatchObject({ reason: 'segments_exhausted' });
    expect(h.handoff.committed).toEqual(['default']);
  });
});

describe('router disclosure (begin path only)', () => {
  it('says the disclosure before the greeting and records it once heard in full', async () => {
    const h = routerHarness({ handoff: { begin: true }, ports: { disclosure } });
    const { say, epoch } = await h.turn('', opening);
    expect(say).toBe(`${AI} ${RECORDED} ${GREETING}`);
    h.receipt(epoch, 'completed', AI);
    expect(h.of('disclosure')).toEqual([]);
    h.receipt(epoch, 'completed', RECORDED);
    expect(h.of('disclosure')).toEqual([{ kinds: ['ai', 'recording'] }]);
    h.receipt(epoch, 'completed', GREETING);
    expect(h.of('disclosure')).toHaveLength(1);
  });

  it('records nothing when the caller cuts it, and never says it twice', async () => {
    const h = routerHarness({ handoff: { begin: true }, ports: { disclosure } });
    const { epoch } = await h.turn('', opening);
    h.receipt(epoch, 'interrupted', `${AI} ${RECORDED}`);
    h.receipt(epoch, 'completed', `${AI} ${RECORDED} ${GREETING}`);
    expect(h.of('disclosure')).toEqual([]);
    expect((await h.turn('', { inputEvent: 'idle' })).say).toBe('Are you still there?');
  });

  it('is not said on an R1 host', async () => {
    const h = routerHarness({ ports: { disclosure } });
    const { say, epoch } = await h.turn('', opening);
    expect(say).toBe(GREETING);
    h.receipt(epoch, 'completed', GREETING);
    expect(h.types()).not.toContain('disclosure');
  });

  it('reads the router release compliance through the plugin config', () => {
    const agent = AgentConfig.parse({
      name: 'Front desk',
      mode: 'agent',
      compliance: { disclosure: { text: RECORDED } },
    });
    const parsed = parseRouterConfig({
      agent,
      workspaceId: 'w',
      sessionId: 's',
      routing: exampleRoutingSnapshot(),
    });
    expect(parsed.agent.compliance?.disclosure?.text).toBe(RECORDED);
    expect(parsed.entry).toBeUndefined();
  });
});

describe('router entry (re-route)', () => {
  it('does not greet: it asks the entry node, saying only the kinds not heard yet', async () => {
    const h = routerHarness({
      handoff: { begin: true },
      ports: { disclosure, entry: entry({ disclosed: ['recording'] }) },
    });
    const { say, epoch } = await h.turn('', opening);
    expect(say).toBe(`${AI} Is it about a card or a loan?`);
    h.receipt(epoch, 'completed', say);
    expect(h.of('disclosure')).toEqual([{ kinds: ['ai'] }]);
  });

  it('decides on its opening when an instant engine can (a call variable rule)', async () => {
    const h = routerHarness({
      handoff: { begin: true },
      host: { call: { variables: { segment: 'vip' } } },
      patch: (raw) =>
        raw.nodes[1].engines.unshift({
          kind: 'rules',
          rules: [
            { branch: 'loans', when: [{ kind: 'variable', name: 'segment', equals: ['vip'] }] },
          ],
        }),
      ports: { entry: entry() },
    });
    expect((await h.turn('', opening)).say).toBe('Connecting you now.');
    expect(h.handoff.begun[0]).toMatchObject({
      reason: 'transfer',
      transfer: { source: 'router' },
      releaseId: I.supportLoans,
    });
    expect(h.of('route.node')[0]).toMatchObject({ turn: 0, node: 'product', outcome: 'matched' });
  });

  it('asks again however the carried context answered the entry node', async () => {
    const h = routerHarness({
      handoff: { begin: true },
      ports: { entry: entry({ context: { values: { intent: 'support', product: 'loans' } } }) },
    });
    expect((await h.turn('', opening)).say).toBe('Is it about a card or a loan?');
    expect(h.of('route.node').map((event) => event.engine)).not.toContain('context');
  });

  it('runs the node fallback when the entry node has no question', async () => {
    const instant = (raw: Record<string, any>) => {
      delete raw.nodes[1].ask;
      raw.nodes[1].engines = [
        {
          kind: 'rules',
          rules: [
            { branch: 'loans', when: [{ kind: 'variable', name: 'segment', equals: ['vip'] }] },
          ],
        },
      ];
    };
    const h = routerHarness({
      handoff: { begin: true },
      patch: (raw) => {
        instant(raw);
        raw.nodes[1].fallback = [{ kind: 'default' }];
      },
      ports: { entry: entry() },
    });
    expect((await h.turn('', opening)).say).toBe('Connecting you now.');
    expect(h.of('route.fallback')).toMatchObject([{ step: 'default', result: 'taken' }]);
    expect(h.handoff.begun[0]).toMatchObject({ reason: 'transfer', releaseId: I.salesEn });

    const reask = routerHarness({
      handoff: { begin: true },
      patch: (raw) => {
        instant(raw);
        raw.nodes[1].fallback[0].line = { en: 'Card or loan?' };
      },
      ports: { entry: entry() },
    });
    expect((await reask.turn('', opening)).say).toBe('Card or loan?');
  });

  it('starts its limits over: turns from zero, time from its own first turn', async () => {
    const h = routerHarness({
      handoff: { begin: true },
      patch: (raw) => (raw.limits = { maxTurns: 1, maxRouteSeconds: 10 }),
      ports: { entry: entry() },
    });
    h.host.advance(3_600_000);
    await h.turn('', opening);
    h.host.advance(5_000);
    expect((await h.turn('hmm')).say).not.toBe('Connecting you now.');
    expect(h.of('route.fallback').filter((event) => event.step === 'limit')).toEqual([]);
    expect((await h.turn('still unsure')).say).toBe('Connecting you now.');
    expect(h.of('route.fallback').at(-2)).toMatchObject({ step: 'limit', reason: 'max_turns' });
  });

  it('prepares as a transfer on a host without begin', async () => {
    const h = routerHarness({ ports: { entry: entry() } });
    await h.turn('', opening);
    await h.turn('a card');
    expect(h.handoff.prepared[0]).toMatchObject({
      reason: 'transfer',
      transfer: { source: 'router' },
    });
  });

  it('parses an entry and refuses a malformed one', () => {
    const agent = AgentConfig.parse({ name: 'Front desk', mode: 'agent' });
    const base = { agent, workspaceId: 'w', sessionId: 's', routing: exampleRoutingSnapshot() };
    expect(parseRouterConfig({ ...base, entry: entry() }).entry).toMatchObject({ node: 'product' });
    expect(() => parseRouterConfig({ ...base, entry: { ...entry(), transfer: 0 } })).toThrow();
  });
});
