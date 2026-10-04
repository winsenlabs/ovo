import type { Clock, UsageMeter } from '@winsendotai/ovo-contracts';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { describe, expect, it } from 'vitest';
import { resolveBinding } from '../src/binding.ts';
import { jevDecision } from '../src/decide.ts';
import { JevRequestError, JevTimeoutError } from '../src/wire.ts';
import { CHOICE_BODY, jevScript, jevStep } from '../src/testing.ts';
import { LABEL, choiceRequest } from './requests.ts';

/** A clock a test drives by hand, so a timeout needs no wall time. */
function manualClock() {
  let now = 0;
  const due: { at: number; fn: () => void }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const entry = { at: now + ms, fn };
      due.push(entry);
      return () => {
        const index = due.indexOf(entry);
        if (index >= 0) due.splice(index, 1);
      };
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const entry of due.filter((e) => e.at <= now)) {
        due.splice(due.indexOf(entry), 1);
        entry.fn();
      }
    },
  };
}

function build(steps: ReturnType<typeof jevStep>, over: Record<string, unknown> = {}) {
  const meters: UsageMeter[] = [];
  const timer = manualClock();
  const net = createFixtureNet([jevScript(steps)], { clock: timer.clock });
  const decision = jevDecision(
    net,
    'fixture-key',
    resolveBinding({ calibrationLabel: LABEL, ...over }),
    (meter) => meters.push(meter),
    { sessionId: 'fixture', clock: timer.clock },
  );
  return { meters, net, decision, timer };
}

const signal = () => ({ signal: AbortSignal.timeout(5000) });

describe('vendor refusals', () => {
  it.each([
    [401, false],
    [403, false],
    [422, false],
    [429, true],
    [500, true],
    [503, true],
  ])(
    'HTTP %i is a typed error with retryable=%s and returns no substitute answer',
    async (status, retryable) => {
      const { meters, net, decision } = build(
        jevStep({ status, body: { detail: [{ msg: 'nope' }] } }),
      );
      const error = await decision.decide(choiceRequest, signal()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(JevRequestError);
      expect((error as JevRequestError).status).toBe(status);
      expect((error as JevRequestError).retryable).toBe(retryable);
      // Exactly one meter, `estimated`: the vendor reported no usage on a refusal.
      expect(meters.map((m) => [m.unit, m.state])).toEqual([['input_tokens', 'estimated']]);
      net.assertComplete();
    },
  );
});

describe('cancellation', () => {
  it('an already-aborted signal rejects before any request is made', async () => {
    const { meters, net, decision } = build(jevStep({ body: CHOICE_BODY }));
    const controller = new AbortController();
    controller.abort();
    await expect(decision.decide(choiceRequest, { signal: controller.signal })).rejects.toThrow();
    expect(net.log).toHaveLength(0);
    // Nothing was requested, so nothing is metered.
    expect(meters).toHaveLength(0);
  });

  it('an abort mid-flight rejects and meters exactly once', async () => {
    const { meters, net, decision } = build(jevStep({ delayMs: 1000, body: CHOICE_BODY }));
    const controller = new AbortController();
    const settled = decision
      .decide(choiceRequest, { signal: controller.signal })
      .catch((e: unknown) => e);
    // Let the request reach the in-flight delay before aborting, so this exercises cancellation of
    // a live call rather than the already-aborted path above.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(meters.map((m) => [m.unit, m.state])).toEqual([['input_tokens', 'estimated']]);
    expect(net.mismatches).toHaveLength(0);
  });
});

describe('the timeout', () => {
  it('fires at the configured timeoutMs and throws JevTimeoutError', async () => {
    const { meters, decision, timer } = build(jevStep({ delayMs: 5000, body: CHOICE_BODY }), {
      timeoutMs: 400,
    });
    const settled = decision.decide(choiceRequest, signal()).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0));
    timer.advance(400);
    const error = await settled;
    expect(error).toBeInstanceOf(JevTimeoutError);
    expect((error as Error).message).toMatch(/timed out after 400ms/);
    expect(meters.map((m) => [m.unit, m.state])).toEqual([['input_tokens', 'estimated']]);
  });

  it('does NOT fire when the reply arrives inside the budget', async () => {
    const { meters, net, decision, timer } = build(jevStep({ delayMs: 100, body: CHOICE_BODY }), {
      timeoutMs: 400,
    });
    const settled = decision.decide(choiceRequest, signal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    timer.advance(100);
    await expect(settled).resolves.toMatchObject({ modelId: 'jev-2026-07-01' });
    expect(meters.map((m) => m.state)).toEqual(['reconciled']);
    net.assertComplete();
  });
});
