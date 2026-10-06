import { describe, expect, it, vi } from 'vitest';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import { GatewayHealth, healthTokenMatches } from '../src/gateway-health.ts';
import { createInboundAdmission } from '../src/inbound-admission.ts';
import { gatewayMediaConfig } from '../src/gateway-config.ts';

function pool(signal?: Record<string, unknown>, ageMs = 1_000) {
  return {
    query: vi.fn(async (sql: string) =>
      sql === 'SELECT 1'
        ? { rows: [{ '?column?': 1 }] }
        : { rows: signal ? [{ signal, age_ms: String(ageMs) }] : [] },
    ),
  };
}

describe('gateway verbose health (OBS-12)', () => {
  it('reports the database, inbound readiness, admissions, refusals and closes', async () => {
    const health = new GatewayHealth({
      pool: pool({ ready: true, readyProtected: 2, warmFloor: 1, reasons: [] }),
      assertArmed: () => undefined,
    });
    health.admission('reserved');
    health.admission('reserved');
    health.admission('busy:capacity');
    health.rejection('Inbound route binding differs', 'CA1');
    health.sessionClosed('caller_hangup');
    health.sessionClosed('error:timeout:route_resolve');
    health.sessionClosed('media idle timeout');
    const snapshot = await health.snapshot();
    expect(snapshot).toMatchObject({
      database: { ok: true },
      inbound: {
        armed: true,
        readiness: { ready: true, readyProtected: 2, warmFloor: 1, stale: false },
      },
      admissions: { reserved: 2, 'busy:capacity': 1 },
      lastRejections: [{ carrierCallId: 'CA1', reason: 'Inbound route binding differs' }],
      closeReasons: { caller_hangup: 1, 'error:timeout': 1, 'media idle timeout': 1 },
      timeouts: { route_resolve: 1, media_idle: 1 },
    });
  });

  it('says when the database fails, admission is not armed and readiness is stale', async () => {
    const failing = {
      query: async (sql: string) => {
        if (sql === 'SELECT 1') throw new Error('connection refused');
        return { rows: [{ signal: { ready: false }, age_ms: '90000' }] };
      },
    };
    const health = new GatewayHealth({
      pool: failing,
      assertArmed: () => {
        throw new Error('not armed');
      },
    });
    expect(await health.snapshot()).toMatchObject({
      database: { ok: false, error: 'connection refused' },
      inbound: { armed: false, readiness: { ready: false, stale: true } },
    });
  });

  it('keeps only the last twenty refusals', () => {
    const health = new GatewayHealth({ pool: pool(), assertArmed: () => undefined });
    for (let index = 0; index < 25; index++) health.rejection(`refusal ${index}`);
    return health.snapshot().then((snapshot) => {
      const rejections = snapshot.lastRejections as { reason: string }[];
      expect(rejections).toHaveLength(20);
      expect(rejections[0]!.reason).toBe('refusal 5');
    });
  });

  it('checks the health token in constant time and never without one', () => {
    expect(healthTokenMatches('Bearer s3cret', 's3cret')).toBe(true);
    expect(healthTokenMatches('Bearer s3cret', 's3creT')).toBe(false);
    expect(healthTokenMatches('s3cret', 's3cret')).toBe(false);
    expect(healthTokenMatches('Bearer ', undefined)).toBe(false);
  });

  it('counts inbound decisions and records refused admissions', async () => {
    const health = new GatewayHealth({ pool: pool(), assertArmed: () => undefined });
    const operations = {
      organizationId: 'org',
      inboundGateway: {
        admit: async () => ({ kind: 'busy', admissionId: 'a', reason: 'capacity' }),
      },
    } as unknown as OperationsService;
    let refuse = false;
    const admission = createInboundAdmission({
      operations,
      routeSecret: 'a'.repeat(32),
      hostFor: () => ({}) as never,
      validateBeforeAdmission: async () => {
        if (refuse) throw new Error('Inbound compatibility blocked: x');
      },
      health,
    });
    const call = {
      carrierId: 'fixture',
      bindingId: 'env',
      carrierCallId: 'CA9',
      from: '+14155550101',
      to: '+14155550102',
      receivedAt: new Date(0),
    };
    expect((await admission.admitInbound(call)).kind).toBe('busy');
    refuse = true;
    await expect(admission.admitInbound(call)).rejects.toThrow('compatibility blocked');
    expect(await health.snapshot()).toMatchObject({
      admissions: { 'busy:capacity': 1 },
      lastRejections: [{ carrierCallId: 'CA9', reason: 'Inbound compatibility blocked: x' }],
    });
  });
});

describe('gateway media config (OBS-9)', () => {
  it('buffers pre-accept audio for the whole handshake deadline by default', () => {
    expect(gatewayMediaConfig({})).toMatchObject({
      handshakeTimeoutMs: 5_000,
      preAcceptBufferMs: 5_000,
      maxPendingFrames: undefined,
    });
    expect(gatewayMediaConfig({ OVO_MEDIA_HANDSHAKE_TIMEOUT_MS: '7000' }).preAcceptBufferMs).toBe(
      7_000,
    );
  });

  it('keeps an operator-set buffer or legacy frame count', () => {
    expect(gatewayMediaConfig({ OVO_MEDIA_PRE_ACCEPT_MS: '200' }).preAcceptBufferMs).toBe(200);
    expect(gatewayMediaConfig({ OVO_MEDIA_MAX_PENDING_FRAMES: '9' })).toMatchObject({
      preAcceptBufferMs: undefined,
      maxPendingFrames: 9,
    });
  });
});
