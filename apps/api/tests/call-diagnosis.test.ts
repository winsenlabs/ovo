import { describe, expect, it } from 'vitest';
import type { StoredCallEvent, UsageEntry } from '@winsendotai/ovo-plugin-storage';
import { callDiagnosis, costByCurrency } from '../src/routes/call-diagnosis.ts';

let sequence = 0;
const event = (type: string, payload: Record<string, unknown> = {}): StoredCallEvent => ({
  id: `e${++sequence}`,
  callId: 'call-1',
  sequence,
  at: `2026-10-06T10:00:${String(sequence).padStart(2, '0')}.000Z`,
  type,
  epoch: 0,
  payload,
});

describe('call diagnosis (OBS-7)', () => {
  it('names the end reason, the stage that timed out, and every failure in order', () => {
    const diagnosis = callDiagnosis([
      event('session.started'),
      event('decision.made', { turnId: 't2', outcome: 'timeout', durationMs: 800 }),
      event('decision.made', { turnId: 't3', outcome: 'succeeded' }),
      event('speech.failed', { turnId: '4', reason: 'tts socket closed' }),
      event('speculation.summary', { decision: { started: 3, reused: 2 }, llm: { started: 0 } }),
      event('telemetry.stats', { accepted: 90, dropped: 2, sampled: 7, failed: 0 }),
      event('session.failed', { reason: 'error:timeout:stt:stt/acme', outcome: 'failed' }),
    ]);
    expect(diagnosis).toMatchObject({
      endReason: 'error:timeout:stt:stt/acme',
      timeout: { stage: 'stt', provider: 'stt/acme' },
      speculation: { decision: { started: 3, reused: 2 } },
      evidence: { dropped: 2 },
      errorsTruncated: false,
    });
    expect(diagnosis.errors.map((error) => [error.type, error.message, error.turnId])).toEqual([
      ['decision.made', 'decision timeout', 't2'],
      ['speech.failed', 'tts socket closed', '4'],
      ['session.failed', 'error:timeout:stt:stt/acme', undefined],
    ]);
  });

  it('falls back to the engine end reason and reports nothing for a clean call', () => {
    expect(
      callDiagnosis([event('session.engine-ended', { reason: 'caller_hangup' })]),
    ).toMatchObject({ endReason: 'caller_hangup', timeout: null, errors: [] });
    expect(callDiagnosis([])).toMatchObject({ endReason: null, timeout: null, evidence: null });
  });

  it('caps the error list on a call with thousands of failures', () => {
    const many = Array.from({ length: 450 }, () => event('speech.dropped', { reason: 'x' }));
    const diagnosis = callDiagnosis(many);
    expect(diagnosis.errors).toHaveLength(200);
    expect(diagnosis.errorsTruncated).toBe(true);
  });
});

describe('cost by currency (OBS-7)', () => {
  const line = (currency: string, amountMinor: string, state: UsageEntry['state']) =>
    ({ currency, amountMinor, state }) as UsageEntry;

  it('totals every currency, estimated and reconciled apart', () => {
    expect(
      costByCurrency([
        line('INR', '150', 'estimated'),
        line('INR', '50', 'reconciled'),
        line('USD', '7', 'estimated'),
        line('USD', 'not-a-number', 'estimated'),
      ]),
    ).toEqual([
      { currency: 'INR', estimatedMinor: '150', reconciledMinor: '50', lines: 2 },
      { currency: 'USD', estimatedMinor: '7', reconciledMinor: '0', lines: 1 },
    ]);
  });
});
