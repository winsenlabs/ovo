import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CarrierProtocolError,
  MULAW_8K,
  type CarrierCapabilities,
  type CarrierControlFactory,
  type CarrierHostPorts,
  type CarrierHttpRoute,
  type CarrierIngress,
  type DialRequest,
  type HangupQuery,
  type InboundDecision,
  type MediaCodecSession,
  type MediaSerializer,
  type Reconciliation,
  type TelephonyControl,
  type UpgradeRequest,
} from '../src/index.ts';

/** A doc-shaped fake carrier. It exists to prove the §2.8 contracts are implementable as written. */
const capabilities: CarrierCapabilities = {
  carrierId: 'fixture',
  media: {
    formats: [MULAW_8K],
    outboundChunk: { minBytes: 3200, maxBytes: 100_000, multipleOf: 320 },
    playbackEvidence: 'carrier-processed',
    clear: true,
    clearFlushesMarkers: 'unknown',
    dtmf: true,
    queryOnMediaUrl: true,
  },
  control: {
    callIdTiming: 'after-answer',
    streamParams: 'on-answer',
    streamCallIdMatchesDial: 'unknown',
    cancelBeforeAnswer: true,
    handoff: ['phone', 'end'],
    amd: 'none',
    maxDuration: true,
    reconcile: 'by-request-id',
    hangup: 'close-stream',
  },
  continuation: 'none',
  webhookAuth: 'url-secret',
  pacing: { cps: 1 },
};

const control: TelephonyControl = {
  async dial(request) {
    const url = new URL(request.media.url);
    if (url.protocol !== 'wss:' || url.search)
      return {
        kind: 'rejected',
        requestId: request.requestId,
        reason: 'media url',
        retryable: false,
      };
    return { kind: 'accepted', requestId: request.requestId, carrierRequestId: 'req-1' };
  },
  async reconcile() {
    return { kind: 'ended', state: 'no_answer' };
  },
  async hangup(query: HangupQuery) {
    return query.carrierCallId || query.carrierRequestId ? 'unsupported' : 'already_ended';
  },
  async handoff() {
    return { kind: 'rejected', retryable: false, reason: 'unsupported' };
  },
};

const factory: CarrierControlFactory = { capabilities, create: () => control };

const session: MediaCodecSession = {
  decode(text) {
    const frame = JSON.parse(text) as { event?: string };
    if (frame.event !== 'start') throw new CarrierProtocolError(`unexpected ${frame.event}`);
    return [
      {
        type: 'start',
        carrierCallId: 'call-1',
        streamId: 's-1',
        format: MULAW_8K,
        routeParams: {},
      },
    ];
  },
  encode: (command) => [JSON.stringify(command.type)],
  flush: () => [],
  terminate: () => [JSON.stringify({ event: 'stop' })],
};

const serializer: MediaSerializer = {
  async authenticateUpgrade(req, ctx) {
    const token = req.url.searchParams.get('t');
    const ok = ctx.verifyUrlSecret({ purpose: 'media', bindingId: ctx.bindingId, token });
    return ok
      ? { ok: true, params: { sid: req.url.searchParams.get('sid') ?? '' } }
      : { ok: false, status: 403 };
  },
  createSession: () => session,
};

const answer: CarrierHttpRoute = {
  method: 'POST',
  purpose: 'answer',
  async handle(req, host) {
    if (!host.verifyUrlSecret(req, { purpose: 'answer', requestId: req.query.r }))
      return { status: 403, contentType: 'text/plain', body: '' };
    const grant = await host.streamForDial({
      carrierId: 'fixture',
      bindingId: req.bindingId,
      dialRequestId: req.query.r,
    });
    return { status: 200, contentType: 'application/json', body: JSON.stringify(grant) };
  },
};

const ingress: CarrierIngress = {
  carrierId: 'fixture',
  capabilities,
  serializer,
  routes: [answer],
  operatorUrls: [{ purpose: 'media-url', label: 'Media URL', help: 'Paste into the flow' }],
  legacyPaths: { '/fixture/media': { purpose: 'media', bindingId: 'env' } },
};

describe('carrier contracts (§2.8)', () => {
  it('implements control, media and ingress with a doc-shaped fake', async () => {
    const dial: DialRequest = {
      requestId: 'dial-1',
      jobId: 'job-1',
      to: '+15550000001',
      from: '+15550000002',
      media: {
        url: 'wss://media.example.test/carriers/fixture/b-1/media',
        routeParams: {},
        format: MULAW_8K,
      },
      callbacks: {
        status: 'https://x.test/status',
        answer: 'https://x.test/answer',
        resume: 'https://x.test/resume',
      },
      maxDurationSec: 1830,
    };
    await expect(
      factory
        .create({ bindingId: 'b', pluginId: 'p', workspaceId: 'w', config: {}, secret: 's' })
        .dial(dial),
    ).resolves.toMatchObject({ kind: 'accepted' });
    await expect(
      control.dial({ ...dial, media: { ...dial.media, url: 'https://x.test/media?sid=1' } }),
    ).resolves.toMatchObject({ kind: 'rejected', retryable: false });
    await expect(control.hangup({ carrierRequestId: 'req-1' })).resolves.toBe('unsupported');
    expect(session.terminate?.()).toEqual(['{"event":"stop"}']);
    expect(() => session.decode('{"event":"media"}')).toThrow(CarrierProtocolError);
    const upgrade: UpgradeRequest = {
      url: new URL('wss://gw.example.test/carriers/fixture/b-1/media?sid=s-1&rt=tok&t=secret'),
      externalUrl: 'wss://gw.example.test/carriers/fixture/b-1/media',
      headers: {},
    };
    await expect(
      ingress.serializer.authenticateUpgrade(upgrade, {
        bindingId: 'b-1',
        resolveBinding: async () => ({
          bindingId: 'b-1',
          pluginId: 'p',
          workspaceId: 'w',
          config: {},
          secret: 's',
        }),
        verifyUrlSecret: ({ token }) => token === 'secret',
      }),
    ).resolves.toEqual({ ok: true, params: { sid: 's-1' } });
  });

  it('keeps the seams later units code against', () => {
    expectTypeOf<DialRequest['callbacks']>().toEqualTypeOf<{
      status: string;
      answer: string;
      amd?: string;
      resume?: string;
    }>();
    expectTypeOf<TelephonyControl['hangup']>().parameter(0).toEqualTypeOf<HangupQuery>();
    expectTypeOf<CarrierHostPorts>().toHaveProperty('streamForDial');
    expectTypeOf<CarrierHostPorts>().toHaveProperty('resumeStream');
    expectTypeOf<CarrierHostPorts>().not.toHaveProperty('mintRouteToken');
    expectTypeOf<UpgradeRequest['url']>().toEqualTypeOf<URL>();
    expectTypeOf<CarrierCapabilities['control']['streamParams']>().toEqualTypeOf<
      'at-dial' | 'on-answer'
    >();
    expectTypeOf<CarrierCapabilities['control']['streamCallIdMatchesDial']>().toEqualTypeOf<
      boolean | 'unknown'
    >();
    expectTypeOf<CarrierCapabilities['control']['cancelBeforeAnswer']>().toEqualTypeOf<boolean>();
    expectTypeOf<CarrierCapabilities['media']['queryOnMediaUrl']>().toEqualTypeOf<boolean>();
    expectTypeOf<CarrierCapabilities['continuation']>().toEqualTypeOf<
      'markup-after-stream' | 'none'
    >();
    expectTypeOf<CarrierHttpRoute['purpose']>().extract<'answer'>().toEqualTypeOf<'answer'>();
    expectTypeOf<Extract<Reconciliation, { kind: 'live' }>['carrierCallId']>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<Parameters<CarrierHostPorts['mediaUrl']>[2]>().toEqualTypeOf<
      { query?: Record<string, string> } | undefined
    >();
    expectTypeOf<Parameters<CarrierHostPorts['callbackUrl']>[3]>().toEqualTypeOf<
      { requestId?: string } | undefined
    >();
    const decisions: InboundDecision['kind'][] = [
      'connect',
      'wait',
      'callback-offer',
      'human',
      'busy',
      'reject',
      'hangup',
    ];
    expect(decisions).toHaveLength(7);
  });
});
