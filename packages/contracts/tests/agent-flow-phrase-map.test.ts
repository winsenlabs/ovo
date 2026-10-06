import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFlow,
  compileFlow,
  flowIntents,
  matchFlowPhrase,
  normalizeForMatch,
} from '../src/index.ts';
import { collectionsFlow } from './flow-fixture.ts';

/** The widest flow the schema accepts for one listen set: 64 intents of 500 phrases each. */
function wideFlow() {
  const flow = collectionsFlow();
  const payment = flow.listens.find((listen) => listen.id === 'payment')!;
  // The authored promise_to_pay intent keeps the payment nodes reachable.
  payment.intents = [
    ...payment.intents,
    ...Array.from({ length: 63 }, (_, intent) => ({
      key: `intent_${intent}`,
      description: `Intent ${intent}`,
      phrases: Array.from({ length: 500 }, (_, phrase) => `Phrase ${intent} number ${phrase}!`),
      next: 'goodbye',
    })),
  ];
  return compileFlow(AgentFlow.parse(flow));
}

/** What `matchFlowPhrase` did before the map: normalise every phrase of every intent. */
function scan(compiled: ReturnType<typeof compileFlow>, listen: string, reply: string) {
  const normalized = normalizeForMatch(reply);
  if (!normalized) return undefined;
  return flowIntents(compiled, listen).find((intent) =>
    intent.phrases.some((phrase) => normalizeForMatch(phrase) === normalized),
  )?.key;
}

afterEach(() => vi.restoreAllMocks());

describe('the precomputed phrase map', () => {
  const compiled = wideFlow();

  it('answers exactly as the linear scan did, globals included and per listen set', () => {
    const replies = [
      'phrase 0 number 0',
      'PHRASE 62 number 499.',
      'phrase 42 number 7 please',
      'pardon',
      'Sorry!',
      'yes',
      '',
      '...',
    ];
    for (const listen of ['identity', 'payment', 'wrapup'])
      for (const reply of replies)
        expect(matchFlowPhrase(compiled, listen, reply), `${listen}: ${reply}`).toBe(
          scan(compiled, listen, reply),
        );
    expect(matchFlowPhrase(compiled, 'payment', 'phrase 62 number 499')).toBe('intent_62');
    expect(matchFlowPhrase(compiled, 'payment', 'pardon')).toBe('repeat');
  });

  it('normalises only the reply, however many phrases the flow authors', () => {
    const normalize = vi.spyOn(String.prototype, 'normalize');
    expect(matchFlowPhrase(compiled, 'payment', 'phrase 62 number 499')).toBe('intent_62');
    expect(matchFlowPhrase(compiled, 'payment', 'not a phrase at all')).toBeUndefined();
    // One per reply. The scan normalised every one of the 31,500-odd phrases for the miss alone.
    expect(normalize).toHaveBeenCalledTimes(2);
    normalize.mockClear();
    scan(compiled, 'payment', 'not a phrase at all');
    expect(normalize.mock.calls.length).toBeGreaterThan(31_500);
  });

  it('still refuses a listen set the flow does not have', () => {
    expect(() => matchFlowPhrase(compiled, 'missing', 'yes')).toThrow(
      'Flow has no listen set missing',
    );
  });
});
