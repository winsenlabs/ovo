import type {
  CarrierHttpRequest,
  CarrierMediaEvent,
  NetFixtureScript,
  NetPort,
  SipTrunkControlClient,
  UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import { encodeBase64 } from './bytes.ts';
import { controlRequest, controlUrl } from './client.ts';
import { canonicalUrl, signRequest } from './sign.ts';

/** Fixture provenance: ovo-sip/1 is OVO's own protocol, specified in the W11 design (§5). */
export const SIP_FIXTURE_SOURCE =
  'https://github.com/winsenlabs/ovo/blob/main/docs/architecture/sip-gateway.md';
export const SIP_FIXTURE_RETRIEVED = '2026-10-13';
export const SIP_FIXTURE_HOST = 'sip-gateway.fixture';

/**
 * A `Cap.sipTrunkControl` client over a NetPort, so `describeCarrier` REST scripts can drive the
 * control API on host `sip-gateway.fixture` with FixtureNet.
 */
export function sipTrunkClientOverNet(
  net: NetPort,
  baseUrl = `https://${SIP_FIXTURE_HOST}`,
): SipTrunkControlClient {
  return {
    request({ method, path, query, body, signal }) {
      return controlRequest(net.fetch.bind(net), controlUrl(baseUrl, path, query), {
        method,
        headers: { authorization: 'Bearer fixture-control-token' },
        body,
        ...(signal ? { signal } : {}),
      });
    },
  };
}

/** One strict control-API exchange as a NetFixtureScript. */
export function sipControlScript(step: {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string>;
  where?: Record<string, unknown>;
  reply: { status: number; body: unknown };
}): NetFixtureScript[] {
  return [
    {
      host: SIP_FIXTURE_HOST,
      source: SIP_FIXTURE_SOURCE,
      retrieved: SIP_FIXTURE_RETRIEVED,
      steps: [
        {
          expect: 'http',
          method: step.method,
          url: controlUrl(`https://${SIP_FIXTURE_HOST}`, step.path, step.query),
          ...(step.method === 'POST' ? { body: 'json' as const } : {}),
          ...(step.where ? { where: step.where } : {}),
          reply: { status: step.reply.status, body: JSON.stringify(step.reply.body) },
        },
      ],
    },
  ];
}

/** Encodes carrier-neutral events as the frames the sip-gateway sends (host-local fixture calls). */
export function createSipFixtureFrameEncoder(): (event: CarrierMediaEvent) => string {
  let seq = 0;
  return (event) => {
    switch (event.type) {
      case 'connected':
        return JSON.stringify({ event: 'connected', v: 1 });
      case 'start':
        return JSON.stringify({
          event: 'start',
          callId: event.carrierCallId,
          streamId: event.streamId,
          format: { encoding: 'mulaw', sampleRate: 8000 },
          routeParams: event.routeParams,
        });
      case 'audio':
        seq = Math.max(seq + 1, event.seq);
        return JSON.stringify({
          event: 'media',
          seq,
          tsMs: event.timestampMs,
          payload: encodeBase64(event.payload),
        });
      case 'dtmf':
        return JSON.stringify({
          event: 'dtmf',
          digit: event.digit,
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        });
      case 'played':
        return JSON.stringify({ event: 'mark', name: event.name });
      case 'cleared':
        return JSON.stringify({ event: 'cleared' });
      case 'stop':
        return JSON.stringify({
          event: 'stop',
          reason: event.reason === 'unknown' ? 'stream-ended' : event.reason,
        });
    }
  };
}

const MULAW = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };
const STREAM = 'st_0b0e8f3c-6f53-4c1a-9a55-0f6d2c3b7e10';
const ROUTE = { sid: 'session-1', rt: 'route-token-1' };

/** The conformance jsonl transcript (structurally a conformance `JsonlFixture`). */
export const sipMediaTranscript = Object.freeze({
  name: 'sip-media.jsonl',
  header: {
    source: SIP_FIXTURE_SOURCE,
    retrieved: SIP_FIXTURE_RETRIEVED,
    verbatim: ['ovo-sip/1 media frames as specified in the W11 design section 5.3'],
    unconfirmed: [],
  },
  lines: [
    { dir: 'in', frame: { event: 'connected', v: 1 }, events: [{ type: 'connected' }] },
    {
      dir: 'in',
      frame: {
        event: 'start',
        callId: 'a84b4c76e66710@pc33.example',
        streamId: STREAM,
        format: { encoding: 'mulaw', sampleRate: 8000 },
        routeParams: ROUTE,
      },
      events: [
        {
          type: 'start',
          carrierCallId: 'a84b4c76e66710@pc33.example',
          streamId: STREAM,
          format: MULAW,
          routeParams: ROUTE,
        },
      ],
    },
    {
      dir: 'in',
      frame: { event: 'media', seq: 1, tsMs: 0, payload: '//8=' },
      events: [{ type: 'audio', seq: 1, timestampMs: 0, payloadBase64: '//8=' }],
    },
    {
      dir: 'out',
      frame: { event: 'media', payload: '//8=' },
      command: { type: 'audio', payloadBase64: '//8=' },
    },
    {
      dir: 'out',
      frame: { event: 'mark', name: 'seg-1' },
      command: { type: 'mark', name: 'seg-1' },
      flush: true,
    },
    {
      dir: 'in',
      frame: { event: 'mark', name: 'seg-1' },
      events: [{ type: 'played', name: 'seg-1' }],
    },
    {
      dir: 'in',
      frame: { event: 'dtmf', digit: '5', durationMs: 120 },
      events: [{ type: 'dtmf', digit: '5', durationMs: 120 }],
    },
    { dir: 'out', frame: { event: 'clear' }, command: { type: 'clear' } },
    { dir: 'in', frame: { event: 'cleared' }, events: [{ type: 'cleared' }] },
    {
      dir: 'in',
      frame: { event: 'media', seq: 2, tsMs: 20, payload: 'f39/' },
      events: [{ type: 'audio', seq: 2, timestampMs: 20, payloadBase64: 'f39/' }],
    },
    {
      dir: 'in',
      frame: { event: 'stop', reason: 'caller-hangup' },
      events: [{ type: 'stop', reason: 'caller-hangup' }],
    },
  ] as { dir: 'in' | 'out'; frame: unknown; [extra: string]: unknown }[],
});

/** A signed `CarrierHttpRequest` as the media gateway would hand it to a route. */
export async function signedSipHttpRequest(input: {
  key: Uint8Array;
  carrierId: string;
  bindingId: string;
  purpose: 'inbound' | 'status' | 'resume';
  body: unknown;
  query?: Record<string, string>;
  publicBaseUrl?: string;
  now: number;
  nonce?: string;
  /** Sign this path instead of the request's own (wrong-path vectors). */
  signedPath?: string;
}): Promise<CarrierHttpRequest> {
  const base = input.publicBaseUrl ?? 'https://ovo.example.test';
  const path = `/carriers/${input.carrierId}/${input.bindingId}/${input.purpose}`;
  const search = new URLSearchParams(input.query ?? {}).toString();
  const rawBody = new TextEncoder().encode(JSON.stringify(input.body));
  const headers = await signRequest({
    key: input.key,
    method: 'POST',
    externalUrl: canonicalUrl(base, input.signedPath ?? path, 'https'),
    body: rawBody,
    now: input.now,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  });
  return {
    method: 'POST',
    externalUrl: `${canonicalUrl(base, path, 'https')}${search ? `?${search}` : ''}`,
    query: { ...input.query },
    headers,
    rawBody,
    bindingId: input.bindingId,
  };
}

/** A signed media upgrade as the media gateway would hand it to `authenticateUpgrade`. */
export async function signedSipUpgrade(input: {
  key: Uint8Array;
  carrierId: string;
  bindingId: string;
  publicBaseUrl?: string;
  now: number;
  nonce?: string;
}): Promise<UpgradeRequest> {
  const externalUrl = canonicalUrl(
    input.publicBaseUrl ?? 'https://ovo.example.test',
    `/carriers/${input.carrierId}/${input.bindingId}/media`,
    'wss',
  );
  const headers = await signRequest({
    key: input.key,
    method: 'GET',
    externalUrl,
    body: new Uint8Array(0),
    now: input.now,
    ...(input.nonce ? { nonce: input.nonce } : {}),
  });
  return { url: new URL(externalUrl), externalUrl, headers };
}
