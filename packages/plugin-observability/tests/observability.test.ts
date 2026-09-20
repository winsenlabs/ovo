import { describe, it, expect } from 'vitest';
import { compose } from '@winsendotai/ovo-runtime';
import {
  priceUsage,
  summarizeUsage,
  projectSession,
  redact,
  observabilityPlugin,
} from '../src/index.ts';
const usage = {
  id: 'u',
  workspaceId: 'w',
  sessionId: 's',
  provider: 'p',
  providerRequestId: 'r',
  quantity: '0.1',
  unit: 'characters',
  state: 'estimated' as const,
};
const card = {
  id: 'c',
  version: '2026-09',
  provider: 'p',
  unit: 'characters',
  currency: 'INR',
  minorUnitsPerBlock: '3',
  blockQuantity: '1',
};
const start = {
  schemaVersion: 1,
  id: '92428508-d6fc-4ee1-a005-1e6847968802',
  workspaceId: 'w',
  sessionId: 's',
  sequence: 0,
  ownershipEpoch: 1,
  timestamp: '2026-09-20T12:00:00.000Z',
  ingestedAt: '2026-09-20T12:00:00.000Z',
  type: 'session.started',
  payload: {},
};
describe('bounded telemetry and projections', () => {
  it('retains native units and rounds money without binary float', () => {
    expect(priceUsage(usage, card).amountMinor).toBe('0');
    expect(priceUsage({ ...usage, quantity: '0.5' }, card).amountMinor).toBe('2');
    expect(
      priceUsage({ ...usage, quantity: '999999999999999999999999999999' }, card).amountMinor,
    ).toBe('2999999999999999999999999999997');
  });
  it('refuses mismatched price units and malformed decimals', () => {
    expect(() => priceUsage({ ...usage, unit: 'tokens' }, card)).toThrow('unit');
    expect(() => priceUsage({ ...usage, quantity: '1e4' }, card)).toThrow('decimal');
  });
  it('deduplicates identical usage but never mixes currencies or states', () => {
    const a = priceUsage({ ...usage, quantity: '1' }, card),
      b = priceUsage(
        { ...usage, id: 'v', state: 'reconciled', quantity: '2' },
        { ...card, currency: 'USD' },
      );
    expect(summarizeUsage([a, a, b])).toEqual({
      INR: { estimatedMinor: '3', reconciledMinor: '0' },
      USD: { estimatedMinor: '0', reconciledMinor: '6' },
    });
    expect(() => summarizeUsage([a, { ...a, amountMinor: '8' }])).toThrow('Conflicting');
  });
  it('replays duplicates/out-of-order events and rejects gaps and stale ownership', () => {
    const end = {
      ...start,
      id: 'b09b342a-2fc9-4f17-bec9-45965f814a2b',
      sequence: 1,
      type: 'session.ended',
    };
    expect(projectSession([end, start, start], 'w', 's')).toMatchObject({
      lastSequence: 1,
      status: 'ended',
    });
    expect(() => projectSession([end], 'w', 's')).toThrow('gap');
    expect(() => projectSession([start, { ...end, ownershipEpoch: 0 }], 'w', 's')).toThrow('Stale');
    expect(() => projectSession([start], 'other', 's')).toThrow('Cross-session');
  });
  it('redacts nested payloads and binds as a normal plugin', async () => {
    expect(
      redact({
        authorization: 'Bearer abc',
        nested: { input: { secret: 's' }, message: 'Call +919876543210 or x@example.com' },
      }),
    ).toEqual({
      authorization: '[redacted]',
      nested: { input: '[redacted]', message: 'Call [number] or [email]' },
    });
    const app = await compose([{ id: 'ovo.observability' }], [observabilityPlugin]);
    expect(app.ctx.get('ovo.observability')).toBeDefined();
    await app.dispose();
  });
});
