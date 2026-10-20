import { beforeAll, describe, expect, it } from 'vitest';
import { routingScorecardGate, scoreRoutingCorpus } from '../src/eval/index.ts';
import { exampleRoutingSnapshot } from '../src/testing.ts';
import type { RoutingScorecard } from '../src/wire/index.ts';
import { HAND_CASES } from './support-corpus.ts';

let baseline: RoutingScorecard;
beforeAll(async () => {
  baseline = await scoreRoutingCorpus({
    snapshot: exampleRoutingSnapshot(),
    cases: HAND_CASES,
    name: 'hand',
    engineMode: 'recorded',
    flags: { transferEnabled: false, humanQueueEnabled: true },
    router: { timezone: 'Asia/Kolkata' },
  });
});
const copy = (edit: (card: RoutingScorecard) => void = () => {}) => {
  const card = structuredClone(baseline);
  edit(card);
  return card;
};
const rateOf = (correct: number, total: number) => ({ correct, total, rate: correct / total });

describe('routingScorecardGate', () => {
  it('passes a scorecard identical to its baseline, and one that improves on it', () => {
    expect(routingScorecardGate(baseline, copy())).toEqual({ ok: true, failures: [] });
    const better = copy((card) => {
      card.totals = { cases: 5, passed: 5, failed: 0 };
      card.failures = [];
      card.accuracy.member = rateOf(3, 3);
      card.fallbackRate = { ...rateOf(1, 5), byStep: {} };
    });
    expect(routingScorecardGate(baseline, better).ok).toBe(true);
  });

  it('fails when fewer cases pass', () => {
    const worse = copy((card) => (card.totals = { cases: 5, passed: 3, failed: 2 }));
    expect(routingScorecardGate(baseline, worse)).toEqual({
      ok: false,
      failures: ['passed cases fell from 4 to 3'],
    });
  });

  it('fails when a case that passed now fails, even if another was fixed', () => {
    const swapped = copy((card) => {
      card.failures = [
        { id: 'c1', expected: {}, actual: {}, diff: ['member: expected "a", got "b"'] },
      ];
    });
    expect(routingScorecardGate(baseline, swapped).failures).toEqual([
      'case c1 passed in the baseline and now fails',
    ]);
  });

  it.each([
    [
      'an accuracy rate falls',
      (c: RoutingScorecard) => (c.accuracy.branch = rateOf(1, 3)),
      'branch accuracy fell from 66.7% to 33.3%',
    ],
    [
      'the fallback rate rises',
      (c: RoutingScorecard) => (c.fallbackRate = { ...rateOf(3, 5), byStep: {} }),
      'fallback rate rose from 40.0% to 60.0%',
    ],
    [
      'the clarify rate rises',
      (c: RoutingScorecard) => (c.clarifyRate = rateOf(2, 5)),
      'clarify rate rose from 20.0% to 40.0%',
    ],
    [
      'the end rate rises',
      (c: RoutingScorecard) => (c.endRate = rateOf(2, 5)),
      'end rate rose from 20.0% to 40.0%',
    ],
  ])('fails when %s', (_name, edit, message) => {
    expect(routingScorecardGate(baseline, copy(edit)).failures).toEqual([message]);
  });

  it('tolerates movement inside the thresholds and no more', () => {
    const wobble = copy((card) => {
      card.fallbackRate = { ...rateOf(3, 5), byStep: {} };
      card.accuracy.branch = rateOf(1, 3);
    });
    expect(routingScorecardGate(baseline, wobble, { fallbackRate: 0.25, accuracy: 0.34 }).ok).toBe(
      true,
    );
    expect(routingScorecardGate(baseline, wobble, { fallbackRate: 0.1, accuracy: 0.34 }).ok).toBe(
      false,
    );
    const passed = copy((card) => (card.totals = { cases: 5, passed: 3, failed: 2 }));
    expect(routingScorecardGate(baseline, passed, { passed: 1 }).ok).toBe(true);
  });

  it('treats a rate that was never measured as nothing to hold', () => {
    expect(baseline.accuracy.queue.rate).toBeNull();
    expect(
      routingScorecardGate(
        baseline,
        copy((c) => (c.accuracy.queue = rateOf(0, 2))),
      ).ok,
    ).toBe(true);
  });

  it('calls a baseline of another corpus or release stale, unless told otherwise', () => {
    const other = copy((card) => {
      card.corpus.digest = 'f'.repeat(64);
      card.routing.digest = '0'.repeat(64);
    });
    expect(routingScorecardGate(baseline, other).failures).toEqual([
      'the corpus changed since the baseline was saved: regenerate it with --save-baseline',
      'the routing snapshot changed since the baseline was saved: regenerate it with --save-baseline',
    ]);
    expect(routingScorecardGate(baseline, other, { allowCorpusChange: true }).ok).toBe(true);
  });
});
