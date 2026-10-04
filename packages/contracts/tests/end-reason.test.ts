import { describe, expect, it } from 'vitest';
import { outcomeFor, type CallOutcome, type EndReason } from '../src/index.ts';

describe('outcomeFor (#20)', () => {
  it.each([
    ['behavior_completed', 'completed'],
    ['caller_hangup', 'caller_ended'],
    ['caller_idle', 'no_input'],
    ['voicemail', 'voicemail'],
    ['max_duration', 'limit'],
    ['transferred', 'transferred'],
    ['superseded', 'canceled'],
    ['drain', 'failed'],
    ['ownership_lost', 'failed'],
    ['error:stt', 'failed'],
    ['error:completed', 'failed'],
  ] as [EndReason, CallOutcome][])('%s → %s', (reason, outcome) => {
    expect(outcomeFor(reason)).toBe(outcome);
  });

  it('is a table, not substring matching', () => {
    expect(outcomeFor('not_completed' as EndReason)).toBe('failed');
    expect(outcomeFor('constructor' as EndReason)).toBe('failed');
    expect(outcomeFor('toString' as EndReason)).toBe('failed');
  });
});
