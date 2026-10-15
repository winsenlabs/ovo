import { describe, expect, it, vi } from 'vitest';
import { CallMemory } from '../src/call-memory.ts';
import { buildHandover, recentTurns } from '../src/transfer-handover.ts';
import {
  agentRequest,
  holdPolicy,
  signal,
  transferHarness,
  transferPolicy,
} from './transfer-fixtures.ts';

const strict = {
  variables: {
    type: 'object',
    properties: {
      account: { type: 'string' },
      amount: { type: 'number' },
      plan: { type: 'string', enum: ['gold', 'silver'] },
    },
    additionalProperties: false,
  },
};

function memory() {
  const call = new CallMemory();
  call.observe('variables.captured', {
    variables: { account: 'A-17', amount: '12', phone: '+9198' },
  });
  call.observe('variables.captured', { variables: { amount: 1200, plan: 'platinum' } });
  call.observe('disclosure', { kinds: ['recording', 'nonsense'] });
  call.observe('route.decision', {
    path: ['intent', 'language'],
    language: 'hi',
    context: { intent: 'billing', bad: 3 },
  });
  return call;
}

describe('CallMemory (transfer design 7.1)', () => {
  it("keeps captured values, disclosures heard and the route from the segments' events", async () => {
    const call = memory();
    expect(call.captured).toEqual({
      account: 'A-17',
      amount: 1200,
      phone: '+9198',
      plan: 'platinum',
    });
    expect([...call.disclosed]).toEqual(['recording']);
    expect(call.route).toEqual({
      path: ['intent', 'language'],
      language: 'hi',
      context: { intent: 'billing' },
    });
    const seen: string[] = [];
    const sink = call.sink({ append: async (type) => void seen.push(type) });
    await sink.append('disclosure', { kinds: ['ai'] });
    expect(seen).toEqual(['disclosure']);
    expect([...call.disclosed]).toEqual(['recording', 'ai']);
  });

  it('keeps final caller words and agent lines as heard, an interrupted line as far as it got', () => {
    const call = new CallMemory();
    call.transcript({
      type: 'user.transcript',
      turnId: 't',
      segmentId: 's',
      text: 'half',
      stability: 'interim',
    });
    call.transcript({
      type: 'user.transcript',
      turnId: 't',
      segmentId: 's',
      text: ' I was charged twice ',
      stability: 'final',
    });
    call.transcript({
      type: 'agent.transcript',
      segmentId: 'a',
      text: 'Sorry about that.',
      state: 'generated',
    });
    call.transcript({
      type: 'agent.transcript',
      segmentId: 'a',
      text: 'Sorry about that.',
      state: 'played',
    });
    call.transcript({
      type: 'agent.transcript',
      segmentId: 'b',
      text: 'Let me check your account and the last two invoices.',
      state: 'interrupted',
      spokenPrefix: 'Let me check',
    });
    expect(call.recent()).toEqual([
      { role: 'caller', text: 'I was charged twice' },
      { role: 'agent', text: 'Sorry about that.' },
      { role: 'agent', text: 'Let me check' },
    ]);
  });

  it('lists the agent releases the call has left, never the current one', () => {
    const call = new CallMemory();
    call.started({ index: 0, role: 'router', agentId: 'r', releaseId: 'release-r', startedAt: 0 });
    call.started({ index: 1, role: 'agent', agentId: 'a', releaseId: 'release-a', startedAt: 1 });
    call.started({ index: 2, role: 'agent', agentId: 'b', releaseId: 'release-b', startedAt: 2 });
    expect([...call.leftReleases(2)]).toEqual(['release-a']);
  });
});

describe('the handover (transfer design 7.9)', () => {
  it('passes the summary, recent turns, route and declared captured values', () => {
    const call = memory();
    call.transcript({
      type: 'user.transcript',
      turnId: 't1',
      segmentId: 's1',
      text: 'Hello',
      stability: 'final',
    });
    call.transcript({
      type: 'agent.transcript',
      segmentId: 'a1',
      text: 'Hi, how can I help?',
      state: 'played',
    });
    call.transcript({
      type: 'user.transcript',
      turnId: 't2',
      segmentId: 's2',
      text: 'Billing please',
      stability: 'final',
    });
    const handover = buildHandover({
      kind: 'transfer',
      transfer: 2,
      from: { role: 'agent', agentId: 'sales', releaseId: 'release-sales' },
      targetKey: 'billing',
      meta: { source: 'llm', reason: 'refund', summary: 'Caller A-17 was charged twice.' },
      memory: call,
      target: strict,
    });
    expect(handover).toEqual({
      kind: 'transfer',
      transfer: 2,
      from: { role: 'agent', agentId: 'sales', releaseId: 'release-sales' },
      targetKey: 'billing',
      reason: 'refund',
      summary: 'Caller A-17 was charged twice.',
      transcript: [
        { role: 'caller', text: 'Hello' },
        { role: 'agent', text: 'Hi, how can I help?' },
        { role: 'caller', text: 'Billing please' },
      ],
      route: { path: ['intent', 'language'], language: 'hi', context: { intent: 'billing' } },
      // `phone` is undeclared, `plan` is outside its enum: neither reaches the target.
      captured: { account: 'A-17', amount: 1200 },
      disclosed: ['recording'],
    });
  });

  it('honours the policy switches, and a route handover carries no free text', () => {
    const call = memory();
    call.transcript({
      type: 'user.transcript',
      turnId: 't',
      segmentId: 's',
      text: 'Hi',
      stability: 'final',
    });
    const off = buildHandover({
      kind: 'transfer',
      meta: { source: 'llm', summary: 'secret', reason: 'why' },
      policy: { summary: false, transcriptTurns: 0, capturedVariables: false },
      memory: call,
      target: strict,
    });
    expect(off).toMatchObject({ transcript: [], captured: {} });
    expect(off).not.toHaveProperty('summary');
    expect(off).not.toHaveProperty('reason');
    const route = buildHandover({
      kind: 'route',
      meta: { source: 'router', summary: 'x' },
      memory: call,
      target: { variables: { type: 'object' } },
    });
    expect(route).not.toHaveProperty('summary');
    expect(route.captured).toEqual(call.captured);
  });

  it('keeps the last turns within the character bound, dropping the oldest first', () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? 'agent' : 'caller') as 'agent' | 'caller',
      text: `${i}`.padEnd(500, '.'),
    }));
    expect(recentTurns(lines, 2).map((line) => line.text.slice(0, 2))).toEqual([
      '25',
      '26',
      '27',
      '28',
      '29',
    ]);
    const kept = recentTurns(lines, 20);
    expect(kept.length).toBe(12);
    expect(kept.at(-1)!.text.startsWith('29')).toBe(true);
    expect(recentTurns(lines, 0)).toEqual([]);
  });
});

describe('handover.capturedVariables: false (transfer design 7.9, 11)', () => {
  /** A transfer whose target fails, then whose `default` fails, then which returns the caller. */
  async function composed(capturedVariables: boolean) {
    const policy = transferPolicy({
      handover: { summary: true, transcriptTurns: 6, capturedVariables },
      hold: holdPolicy({ onTimeout: [{ kind: 'default' }, { kind: 'return' }] }),
    });
    const h = transferHarness({
      first: 'agent',
      policy,
      compose: { 'release-b': 'fail', 'release-default': 'fail' },
    });
    h.memory.observe('variables.captured', { variables: { account: 'A-17' } });
    const agent = await h.started();
    const begun = await h.controller.begin(agentRequest('release-b'), signal());
    if (!begun.ok) throw new Error(begun.reason);
    h.controller.commit(begun.handoffId);
    await agent.complete();
    await vi.waitFor(() => expect(h.journal.entries).toContain('s3.start'));
    return h.targets.map(({ target }) => [target.releaseId, target.captured]);
  }

  it("keeps the call's captured values from every target's variables, not only its handover", async () => {
    expect(await composed(false)).toEqual([
      ['release-b', undefined],
      ['release-default', undefined],
      ['release-a', undefined],
    ]);
    const captured = { account: 'A-17' };
    expect(await composed(true)).toEqual([
      ['release-b', captured],
      ['release-default', captured],
      ['release-a', captured],
    ]);
  });
});
