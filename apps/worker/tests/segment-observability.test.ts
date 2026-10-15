import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerCostPolicyAttachment } from '../src/cost-policy.ts';
import { routeEventSink } from '../src/routing-events.ts';
import { SegmentStats, segmentTelemetry } from '../src/segment-telemetry.ts';
import type { WorkerSessionTelemetry } from '../src/telemetry-runtime.ts';
import { transferWorkerOptions } from '../src/worker-environment.ts';

const usage = (requestId: string, quantity: string) => ({
  provider: 'fixture',
  operation: 'streaming-tts' as const,
  requestId,
  elapsedMs: 20,
  quantity,
  unit: 'characters' as const,
  state: 'estimated' as const,
});

describe('per-segment telemetry (transfer design 7.11)', () => {
  it("stamps every audit of a segment with its index; the rest is the call's own session", () => {
    const audits: [string, Record<string, unknown>][] = [];
    const call = {
      audit: vi.fn((type: string, payload: Record<string, unknown>) => {
        audits.push([type, payload]);
        return true;
      }),
      providerUsage: vi.fn(function (this: unknown) {
        return this;
      }),
      callId: 'call-1',
    };
    const segment = segmentTelemetry(call as unknown as WorkerSessionTelemetry, 3);
    segment.audit('provider.meter', { key: 'stt' });
    expect(audits).toEqual([['provider.meter', { key: 'stt', segment: 3 }]]);
    expect(segment.callId).toBe('call-1');
    // Methods run on the call's session itself, never on the facade.
    expect(segment.providerUsage(usage('r', '1') as never)).toBe(call);
  });

  it("counts a segment's usage by meter key, at most 24 meters", () => {
    const stats = new SegmentStats(2, 'en');
    stats.meter(usage('a', '10'));
    stats.meter(usage('b', '2.5'));
    stats.meter({
      ...usage('c', '1'),
      quantity: undefined,
      state: 'unavailable',
      missing: 'provider-omitted',
      unit: 'audio_seconds',
    } as never);
    expect(stats.usage).toEqual({ 'fixture.streaming-tts.characters': 12.5 });
    for (let meter = 0; meter < 30; meter += 1)
      stats.meter({ ...usage(`m${meter}`, '1'), provider: `p${meter}` });
    expect(Object.keys(stats.usage)).toHaveLength(24);
  });
});

describe('segment cost tagging (transfer design 7.11, ledger 005)', () => {
  it('passes the segment of a usage report to the ledger; call-level usage carries none', async () => {
    const recorded: Record<string, unknown>[] = [];
    const ledger = {
      getBudget: async () => ({ id: 'budget-1', workspaceId: 'workspace-1' }),
      getPriceCard: async () => ({
        id: 'card',
        version: 'v1',
        provider: 'fixture',
        unit: 'characters',
        currency: 'INR',
      }),
      reserveBudget: async () => ({ admitted: true }),
      recordUsage: vi.fn(async (input: Record<string, unknown>) => void recorded.push(input)),
      getSessionCost: async () => ({ totalPaise: '0' }),
    };
    const attachment = createWorkerCostPolicyAttachment({
      ledger: ledger as never,
      policy: {
        budgetId: 'budget-1',
        reservationPaise: '1000',
        maxCallSeconds: 60,
        priceCards: { 'fixture.streaming-tts.characters': { id: 'card', version: 'v1' } },
      },
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      sessionStartedAt: '2026-10-15T00:00:00.000Z',
      prefetchedPriceCards: new Map([
        [
          'fixture.streaming-tts.characters',
          {
            id: 'card',
            version: 'v1',
            provider: 'fixture',
            unit: 'characters',
            currency: 'INR',
          } as never,
        ],
      ]),
      requestTermination: vi.fn(),
    });
    await attachment.reserveBeforeAdmission();
    attachment.providerUsage(usage('r1', '5'), 2);
    attachment.providerUsage(usage('r2', '5'));
    await attachment.controller.flushUsage();
    expect(recorded.map((row) => row.segment)).toEqual([2, undefined]);
    expect(recorded[1]).not.toHaveProperty('segment');
  });
});

describe('routed call events (transfer design 7.11, R1 audit gap 7)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mirrors transfer, segment and disclosure events into the Events tab; stamps disclosures', async () => {
    const audits: [string, Record<string, unknown>][] = [];
    const stored: [string, Record<string, unknown>][] = [];
    const sink = routeEventSink(
      { append: async (type, payload) => void stored.push([type, payload]) },
      {
        releaseId: 'release-a',
        telemetry: { audit: (type, payload) => audits.push([type, payload]) > 0 },
        index: 2,
      },
    );
    for (const type of ['transfer.requested', 'segment.ended', 'disclosure', 'variables.captured'])
      await sink.append(type, type === 'disclosure' ? { kinds: ['ai'] } : { transfer: 1 });
    expect(audits.map(([type]) => type)).toEqual([
      'transfer.requested',
      'segment.ended',
      'disclosure',
    ]);
    expect(stored.find(([type]) => type === 'disclosure')).toEqual([
      'disclosure',
      { kinds: ['ai'], segment: 2 },
    ]);
  });

  it('logs route_decided with ids and codes only', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line));
    const sink = routeEventSink(undefined, {
      releaseId: 'release-default',
      telemetry: { audit: () => true },
      call: { jobId: 'job-1', sessionId: 'session-1' },
    });
    await sink.append('route.decision', {
      ...{ routingPointId: 'point', routingReleaseId: 'routing-1', path: ['intent'] },
      ...{
        target: 'agent',
        agentId: 'sales',
        releaseId: 'release-a',
        poolId: 'pool',
        memberId: 'm',
      },
      ...{ language: 'en', context: { intent: 'sales' }, turns: 2, routeMs: 900 },
    });
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual([
      expect.objectContaining({
        event: 'route_decided',
        jobId: 'job-1',
        sessionId: 'session-1',
        routingReleaseId: 'routing-1',
        target: 'agent',
        agentId: 'sales',
        releaseId: 'release-a',
        poolId: 'pool',
        memberId: 'm',
      }),
    ]);
    expect(logged[0]).not.toHaveProperty('context');
  });
});

describe('the worker transfer environment (Wave 16)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('keeps in-call transfers off unless OVO_ROUTING_TRANSFER_ENABLED is exactly true', () => {
    vi.stubEnv('OVO_ROUTING_TRANSFER_ENABLED', undefined);
    expect(transferWorkerOptions()).toEqual({ transferEnabled: false });
    vi.stubEnv('OVO_ROUTING_TRANSFER_ENABLED', 'TRUE');
    expect(transferWorkerOptions().transferEnabled).toBe(false);
    vi.stubEnv('OVO_ROUTING_TRANSFER_ENABLED', 'true');
    expect(transferWorkerOptions().transferEnabled).toBe(true);
  });
});
