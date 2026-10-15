import { describe, expect, it } from 'vitest';
import type { HandoffPrepareResult } from '@winsendotai/ovo-contracts';
import { EXAMPLE_IDS as I } from '../src/testing.ts';
import { dtmf, opening, routerHarness } from './harness.ts';

async function routed(h = routerHarness()) {
  await h.turn('', opening);
  const { epoch } = await h.turn('1', dtmf('1'));
  return { h, epoch };
}

function deferred() {
  let resolve!: (value: HandoffPrepareResult) => void;
  const promise = new Promise<HandoffPrepareResult>((done) => (resolve = done));
  return { promise, resolve };
}

describe('router behaviour: completion', () => {
  it('completes only on the connecting line receipt, with a route: completion reason', async () => {
    const { h, epoch } = await routed();
    expect(h.behavior.isComplete()).toBe(false);
    expect(h.behavior.completionReason()).toBeUndefined();
    h.receipt(epoch - 1);
    expect(h.behavior.isComplete()).toBe(false);
    h.receipt(epoch);
    expect(h.behavior.isComplete()).toBe(true);
    expect(h.behavior.completionReason()).toBe('route:agent:intent');
  });

  it('a barge-in on the connecting line does not cancel the committed handoff', async () => {
    const { h, epoch } = await routed();
    h.receipt(epoch, 'interrupted');
    expect(h.behavior.isComplete()).toBe(true);
    expect((await h.turn('wait, actually...')).say).toBe('');
    expect(h.handoff.committed).toEqual(['handoff-1']);
    expect(h.handoff.abandoned).toEqual([]);
    expect(h.engines.calls.filter((call) => call.kind === 'llm')).toEqual([]);
  });

  it('says a final line that never played once more, then completes with nothing', async () => {
    const { h } = await routed();
    const again = await h.turn('hello?');
    expect(again.say).toBe('Connecting you now.');
    h.receipt(again.epoch - 1);
    expect(h.behavior.isComplete()).toBe(false);
    expect((await h.turn('hello??')).say).toBe('');
    expect(h.behavior.isComplete()).toBe(true);
  });

  it('ends on an end target: its line, its disposition and route:end', async () => {
    const h = routerHarness({
      patch: (raw) =>
        (raw.nodes[0].branches[0].target = {
          kind: 'end',
          line: { en: 'Sales is closed today. Goodbye.' },
          disposition: 'sales_closed',
        }),
    });
    await h.turn('', opening);
    const { say, epoch } = await h.turn('1', dtmf('1'));
    expect(say).toBe('Sales is closed today. Goodbye.');
    expect(h.core.phase).toBe('ended');
    expect(h.handoff.prepared).toEqual([]);
    expect(h.of('disposition')).toEqual([
      {
        disposition: 'sales_closed',
        turn: 1,
        node: 'intent',
        reason: 'route_end',
        source: 'system',
      },
    ]);
    expect(h.of('route.decision')[0]).toMatchObject({ target: 'end', path: ['intent'] });
    h.receipt(epoch);
    expect(h.behavior.completionReason()).toBe('route:end:intent');
  });

  it('promises a callback: a disposition with source route, due in inMinutes, dialled by its agent', async () => {
    const h = routerHarness({
      patch: (raw) =>
        (raw.nodes[0].branches[0].target = {
          kind: 'callback',
          inMinutes: 60,
          line: { en: 'We will call you back within the hour.' },
          agent: { agentId: 'sales-hi', release: { kind: 'pinned', releaseId: I.salesHi } },
        }),
    });
    await h.turn('', opening);
    expect((await h.turn('1', dtmf('1'))).say).toBe('We will call you back within the hour.');
    expect(h.of('disposition')).toEqual([
      {
        disposition: 'callback',
        turn: 1,
        node: 'intent',
        reason: 'callback',
        source: 'system',
        callback: {
          dueAt: new Date(h.host.now() + 3_600_000).toISOString(),
          timezone: 'Asia/Kolkata',
          source: 'route',
          node: 'intent',
          releaseId: I.salesHi,
        },
      },
    ]);
    expect(h.of('route.decision')[0]).toMatchObject({
      target: 'callback',
      agentId: 'sales-hi',
      releaseId: I.salesHi,
    });
    expect(h.core.completionReason()).toBe('route:callback:intent');
  });

  it('caps the completion reason at 200 characters', async () => {
    const id = (n: number) => `n${n}`.padEnd(70, 'x');
    const h = routerHarness({
      patch: (raw) => {
        raw.root = id(0);
        raw.nodes = [0, 1, 2, 3].map((n) => ({
          id: id(n),
          ask: { en: 'Go on?' },
          engines: [
            { kind: 'rules', rules: [{ branch: 'go', when: [{ kind: 'dtmf', digits: '1' }] }] },
          ],
          branches: [
            n === 3
              ? { key: 'go', description: 'go', target: { kind: 'end', line: { en: 'Bye.' } } }
              : { key: 'go', description: 'go', next: id(n + 1) },
          ],
          fallback: [{ kind: 'end', line: { en: 'Bye.' } }],
        }));
      },
    });
    await h.turn('', opening);
    await h.turn('1', dtmf('1'));
    expect(h.core.completionReason()).toHaveLength(200);
    expect(h.core.completionReason()!.startsWith(`route:end:${id(0)}>${id(1)}>`)).toBe(true);
  });
});

describe('router behaviour: cancel and dispose', () => {
  it('abandons a handoff prepared by a turn that was cancelled before it committed', async () => {
    const pending = deferred();
    const h = routerHarness({ handoff: { prepare: () => pending.promise } });
    await h.turn('', opening);
    const turn = h.turn('1', dtmf('1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.behavior.cancel();
    pending.resolve({ ok: true, handoffId: 'late' });
    expect((await turn).say).toBe('');
    expect(h.handoff.abandoned).toEqual(['late']);
    expect(h.handoff.committed).toEqual([]);
    expect(h.core.phase).toBe('routing');
  });

  it('abandons an uncommitted handoff on dispose', async () => {
    const pending = deferred();
    const h = routerHarness({ handoff: { prepare: () => pending.promise } });
    await h.turn('', opening);
    const turn = h.turn('1', dtmf('1'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const disposed = h.behavior.dispose();
    pending.resolve({ ok: true, handoffId: 'late' });
    await disposed;
    await turn;
    expect(h.handoff.abandoned).toEqual(['late']);
    expect(h.handoff.committed).toEqual([]);
    expect((await h.turn('hello')).say).toBe('');
  });

  it('never abandons a committed handoff', async () => {
    const { h } = await routed();
    h.behavior.cancel();
    await h.behavior.dispose();
    expect(h.handoff.abandoned).toEqual([]);
    expect(h.handoff.committed).toEqual(['handoff-1']);
  });

  it('runs overlapping turns one at a time', async () => {
    const h = routerHarness();
    const first = h.turn('', opening);
    const second = h.turn('1', dtmf('1'));
    expect((await first).say).toBe('Welcome to Acme. How can I help you today?');
    expect((await second).say).toBe('Connecting you now.');
  });
});
