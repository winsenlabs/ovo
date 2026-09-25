import { describe, it, expect } from 'vitest';
import { AgentConfig, Manifest, readDurableEvent } from '../src/index.ts';
describe('versioned external schemas', () => {
  it('supports announcement without inference credentials', () => {
    expect(
      AgentConfig.parse({ name: 'Appointment', mode: 'announcement', message: 'Hello' }).providers,
    ).toEqual({});
  });
  it('rejects an empty mandatory processing phrase', () => {
    expect(() =>
      AgentConfig.parse({ name: 'Agent', mode: 'agent', processing: { initial: '' } }),
    ).toThrow();
  });
  it('rejects incompatible plugin contract versions', () => {
    expect(() =>
      Manifest.parse({
        id: 'p',
        version: '1.0.0',
        contractVersion: 2,
        scope: 'session',
        provides: [],
      }),
    ).toThrow();
  });
  it('reads current durable envelopes and refuses future or malformed generations', () => {
    const event = {
      schemaVersion: 1,
      id: '92428508-d6fc-4ee1-a005-1e6847968802',
      workspaceId: 'test',
      sessionId: 'session',
      sequence: 0,
      ownershipEpoch: 1,
      timestamp: '2026-09-20T12:00:00.000Z',
      ingestedAt: '2026-09-20T12:00:00.000Z',
      type: 'session.started',
      payload: {},
    };
    expect(readDurableEvent(event).schemaVersion).toBe(1);
    expect(() => readDurableEvent({ ...event, schemaVersion: 2 })).toThrow();
    expect(() => readDurableEvent({ ...event, sequence: -1 })).toThrow();
  });
});
