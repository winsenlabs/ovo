import { describe, expect, it } from 'vitest';
import { Cap, type EventSink } from '@winsendotai/ovo-contracts';
import { MemoryCallOutcomeStore } from '@winsendotai/ovo-plugin-storage/outcomes';
import { compose } from '@winsendotai/ovo-runtime';
import { sessionHostServices } from '../src/session-graph-host.ts';
import { auditGuardrail, closeSessionEvents, openSessionEvents } from '../src/session-outcomes.ts';

const identity = { workspaceId: 'ws', callId: 'call-1' };

describe('worker session outcomes (AGT-8)', () => {
  it('records the end of the call after the behaviour events, then flushes', async () => {
    const store = new MemoryCallOutcomeStore();
    const audits: [string, Record<string, unknown>][] = [];
    const telemetry = {
      audit: (type: string, payload: Record<string, unknown>) => !!audits.push([type, payload]),
    };
    expect(openSessionEvents(undefined, identity, telemetry)).toBeUndefined();
    const events = openSessionEvents(store, identity, telemetry)!;
    await events.append('disposition', { disposition: 'promise_to_pay', source: 'jev' });
    await closeSessionEvents(events, 'caller_hangup');
    expect(await store.get('ws', 'call-1')).toMatchObject({
      disposition: 'promise_to_pay',
      outcome: 'caller_ended',
      endReason: 'caller_hangup',
    });
    const failing = openSessionEvents(
      { append: async () => Promise.reject(new Error('down')) },
      identity,
      telemetry,
    )!;
    await closeSessionEvents(failing, 'behavior_completed');
    expect(audits.filter(([type]) => type === 'outcome.write-failed').length).toBeGreaterThan(0);
  });

  it('offers the sink to session plugins only when the call has one', async () => {
    const sink: EventSink = { append: async () => undefined };
    const base = {
      media: {} as never,
      operationStore: {} as never,
      secrets: {} as never,
      usage: () => undefined,
      transcripts: () => undefined,
    };
    expect(sessionHostServices({ ...base, events: sink }).manifest.provides).toContain(Cap.events);
    expect(sessionHostServices(base).manifest.provides).not.toContain(Cap.events);
    const host = sessionHostServices({ ...base, events: sink });
    const composition = await compose([{ id: host.manifest.id }], [host], { scope: 'session' });
    try {
      expect(composition.ctx.get(Cap.events)).toBe(sink);
    } finally {
      await composition.dispose();
    }
  });

  it('audits what the guardrail checked when it checked anything', () => {
    const audits: string[] = [];
    const telemetry = { audit: (type: string) => !!audits.push(type) };
    const composition = (segments: number) => ({
      ctx: {
        get: (key: string) =>
          key === Cap.behavior
            ? { guardrailMetrics: { snapshot: () => ({ segments, flagged: 1 }) } }
            : undefined,
      },
    });
    auditGuardrail(composition(0) as never, telemetry);
    auditGuardrail(composition(3) as never, telemetry);
    auditGuardrail({ ctx: { get: () => undefined } } as never, telemetry);
    expect(audits).toEqual(['guardrail.summary']);
  });
});
