import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CarrierHostPorts } from '@winsendotai/ovo-contracts';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import {
  fixtureCarrierIngress,
  fixtureWebhook,
  signFixtureRequest,
} from '../../../packages/conformance/src/drivers/fixture-carrier.ts';
import { createInboundAdmission } from '../src/inbound-admission.ts';

const admission = {
  carrierId: 'fixture',
  bindingId: 'env',
  carrierCallId: 'CA-test',
  from: '+14155550101',
  to: '+14155550102',
  receivedAt: new Date(0),
};

function setup(decision: unknown) {
  const admit = vi.fn(async () => decision);
  const confirmCallback = vi.fn(async () => decision);
  const operations = {
    organizationId: 'workspace',
    inboundGateway: { admit, confirmCallback },
  } as unknown as OperationsService;
  let host!: CarrierHostPorts;
  const state = createInboundAdmission({
    operations,
    routeSecret: 'a'.repeat(32),
    hostFor: () => host,
  });
  host = {
    ...state,
    resolveBinding: async (bindingId: string) => ({
      bindingId,
      pluginId: 'fixture-plugin',
      workspaceId: 'workspace',
      config: {},
      secret: 'fixture-secret',
    }),
    verifyUrlSecret: () => true,
    mediaUrl: (carrierId: string, bindingId: string) =>
      `wss://voice.example/carriers/${carrierId}/${bindingId}/media`,
    callbackUrl: (carrierId: string, bindingId: string, purpose: string) =>
      `https://voice.example/carriers/${carrierId}/${bindingId}/${purpose}?t=host-token`,
    applyCallEvent: async () => ({ kind: 'applied' }),
    streamForDial: async () => ({ kind: 'unmatched' }),
    resumeStream: async () => ({ kind: 'ended' }),
  } as CarrierHostPorts;
  return { host, admit, confirmCallback };
}

describe('carrier-neutral inbound admission through a carrier route', () => {
  it('mints the grant in C2, stores its hash, and gives the fixture route a connect decision', async () => {
    const { host, admit } = setup({
      kind: 'reserved',
      admissionId: 'admission-1',
      jobId: 'job-1',
      sessionId: 'session-1',
      workerId: 'worker-1',
      workerEndpoint: 'ws://127.0.0.1:4100/internal/media',
      releaseId: 'release-1',
      routeVersion: 1,
    });
    const route = fixtureCarrierIngress().routes.find((item) => item.purpose === 'inbound')!;
    const request = signFixtureRequest(
      'fixture-secret',
      fixtureWebhook({
        externalUrl: 'https://voice.example/carriers/fixture/env/inbound',
        bindingId: 'env',
        form: {
          CallSid: admission.carrierCallId,
          From: admission.from,
          To: admission.to,
        },
      }),
    );
    const reply = await route.handle(request, host);
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('wss://voice.example/carriers/fixture/env/media');
    expect(reply.body).toContain('name="sid" value="session-1"');
    const token = /name="rt" value="([^"]+)"/.exec(reply.body)?.[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({
        carrierCallId: admission.carrierCallId,
        fromNumber: admission.from,
        toNumber: admission.to,
        routeTokenHash: createHash('sha256').update(token!, 'utf8').digest('hex'),
      }),
    );
  });

  it('maps wait, callback, human and busy with host-built URLs', async () => {
    const wait = setup({
      kind: 'wait',
      admissionId: 'a',
      announcement: 'Please wait',
      expiresAt: new Date(30_000),
      pollAfterMs: 1_001,
    });
    expect(await wait.host.admitInbound(admission)).toMatchObject({
      kind: 'wait',
      pauseSeconds: 2,
      announce: true,
      retryUrl: expect.stringContaining('stage=wait'),
    });
    expect(await wait.host.admitInbound({ ...admission, raw: { stage: 'wait' } })).toMatchObject({
      announce: false,
    });
    const callback = setup({
      kind: 'callback',
      admissionId: 'a',
      state: 'prompt',
      announcement: 'Callback?',
    });
    expect(await callback.host.admitInbound(admission)).toMatchObject({
      kind: 'callback-offer',
      prompt: 'Callback?',
      timeoutSeconds: 5,
      digitsUrl: expect.stringContaining('stage=callback'),
    });
    expect(await callback.host.confirmCallback({ ...admission, digits: '1' })).toMatchObject({
      kind: 'callback-offer',
    });
    expect(callback.confirmCallback).toHaveBeenCalledWith(expect.objectContaining({ digits: '1' }));
    const human = setup({
      kind: 'human',
      admissionId: 'a',
      target: '+14155550999',
      announcement: 'Connecting',
    });
    expect(await human.host.admitInbound(admission)).toEqual({
      kind: 'human',
      e164: '+14155550999',
      message: 'Connecting',
    });
    const busy = setup({ kind: 'busy', admissionId: 'a', reason: 'at_capacity' });
    expect(await busy.host.admitInbound(admission)).toEqual({
      kind: 'busy',
      reason: 'at_capacity',
    });
  });
});
