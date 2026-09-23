import { describe, expect, it } from 'vitest';
import { createCarrierHostPorts } from '@winsendotai/ovo-session-host';
import { dialRequestV2 } from '../src/dial-request.ts';
import { createSessionHandshake } from '../src/session-handshake.ts';

function selected(streamParams: 'at-dial' | 'on-answer' = 'at-dial') {
  const ports = createCarrierHostPorts({
    publicBaseUrl: 'https://voice.example.test',
    routeSecret: 'x'.repeat(32),
    operations: {} as never,
    orchestration: {} as never,
    bindings: async () => {
      throw new Error('not used');
    },
  });
  return {
    release: { config: { costPolicy: { maxCallSeconds: 420 } } },
    carrier: {
      carrierId: 'twilio',
      bindingId: 'env',
      capabilities: {
        control: { streamParams },
        media: {
          formats: [{ encoding: 'mulaw', sampleRate: 8000, channels: 1 }],
        },
      },
    },
    ports,
  } as never;
}

const job = { id: 'job-1', workspaceId: 'workspace-1', ownerEpoch: 7, payload: {} };

describe('host-built carrier dial request', () => {
  it.each(['at-dial', 'on-answer'] as const)(
    'uses wss and signed per-call callbacks for %s',
    (streamParams) => {
      const request = dialRequestV2({
        job,
        payload: { to: '+14155550100', from: '+14155550101', ringTimeoutSec: 75 },
        route: { sessionId: 'session-1' },
        token: 'route-token',
        selected: selected(streamParams),
      });
      expect(request.media.url).toBe('wss://voice.example.test/carriers/twilio/env/media');
      expect(request.media.url).not.toContain('?');
      expect(request.media.routeParams).toEqual(
        streamParams === 'at-dial' ? { sid: 'session-1', rt: 'route-token' } : {},
      );
      for (const purpose of ['status', 'answer', 'amd', 'resume'] as const) {
        const url = new URL(request.callbacks[purpose]!);
        expect(url.pathname).toBe(`/carriers/twilio/env/${purpose}`);
        expect(url.searchParams.get('r')).toBe('job-1:7');
        expect(url.searchParams.get('t')).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(request.maxDurationSec).toBe(450);
      expect(request.ringTimeoutSec).toBe(75);
    },
  );

  it('extends the handshake past ring timeout by sixty seconds with a 32-byte token', () => {
    const before = Date.now();
    const handshake = createSessionHandshake({
      job: { ...job, ownerId: 'worker-1' } as never,
      workerEndpoint: 'wss://worker.example.test/session',
      ringTimeoutSec: 75,
    });
    const token = Buffer.from(handshake.token, 'base64url');
    expect(token).toHaveLength(32);
    expect(handshake.route.handshakeExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 135_000);
    expect(handshake.route.handshakeExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 135_000);
  });
});
