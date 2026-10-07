import { describe, expect, it } from 'vitest';
import { RetryOutcome, WorkspaceCompliance } from '@winsendotai/ovo-contracts';
import { DEFAULT_RETRY, attemptOutcome, dispositionOutcome, retryAfter } from '../../src/index.ts';

const settings = WorkspaceCompliance.parse({});
const now = new Date('2026-10-07T06:30:00Z');
const minutesLater = (at: Date | undefined) =>
  at === undefined ? undefined : (at.getTime() - now.getTime()) / 60_000;

describe('intent-aware retries (spec 3.7)', () => {
  it('maps carrier results onto retry outcomes', () => {
    expect(attemptOutcome('failed', 'busy')).toBe('busy');
    expect(attemptOutcome('failed', 'no_answer')).toBe('no_answer');
    expect(attemptOutcome('failed')).toBe('no_answer');
    expect(attemptOutcome('failed', 'voicemail')).toBe('voicemail');
    expect(attemptOutcome('failed', 'completed_without_session')).toBe('abandoned');
    expect(attemptOutcome('failed', 'canceled')).toBe('cancelled');
    expect(attemptOutcome('failed', 'sip 503')).toBe('failed');
    expect(attemptOutcome('succeeded')).toBe('connected');
    expect(attemptOutcome('unknown')).toBe('unknown');
  });

  it('maps flow dispositions, with the workspace map first', () => {
    expect(dispositionOutcome('do_not_call_requested', settings)).toBe('opted_out');
    expect(dispositionOutcome('wrong_number', settings)).toBe('wrong_number');
    expect(dispositionOutcome('dispute_raised', settings)).toBe('dispute');
    expect(dispositionOutcome('relief_team_callback', settings)).toBe('callback_requested');
    expect(dispositionOutcome('completed', settings)).toBeUndefined();
    const mapped = WorkspaceCompliance.parse({ dispositionMap: { waiver_requested: 'refused' } });
    expect(dispositionOutcome('waiver_requested', mapped)).toBe('refused');
  });

  it('retries every outcome as the matrix says, and never after a refusal', () => {
    const expected: Record<RetryOutcome, (number | undefined)[]> = {
      opted_out: [undefined],
      wrong_number: [undefined],
      refused: [undefined],
      dispute: [undefined],
      callback_requested: [undefined],
      busy: [30, 120, undefined],
      no_answer: [120, 240, 1_440, undefined],
      voicemail: [1_440, undefined],
      failed: [15, 15, undefined],
      abandoned: [undefined],
      cancelled: [undefined],
      unknown: [undefined],
      connected: [undefined],
    };
    for (const outcome of RetryOutcome.options) {
      const backoffs = expected[outcome].map((_, previous) =>
        minutesLater(retryAfter(outcome, previous, settings, now)),
      );
      expect([outcome, backoffs]).toEqual([outcome, expected[outcome]]);
    }
    expect(DEFAULT_RETRY.refused.cooloffDays).toBe(30);
  });

  it('lets the workspace change a rule', () => {
    const custom = WorkspaceCompliance.parse({
      retry: { busy: { retry: true, backoffMinutes: [60], maxRetries: 1 } },
    });
    expect(minutesLater(retryAfter('busy', 0, custom, now))).toBe(60);
    expect(retryAfter('busy', 1, custom, now)).toBeUndefined();
  });
});
