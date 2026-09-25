import { httpJson } from '@winsendotai/ovo-plugin-kit';
import {
  MULAW_8K,
  type CarrierCapabilities,
  type CarrierControlFactory,
  type CarrierHttpRequest,
  type CarrierIngress,
  type DialResult,
  type NetPort,
  type ResolvedBinding,
  type TelephonyControl,
} from '@winsendotai/ovo-contracts';
import {
  FIXTURE_CARRIER_ID,
  FIXTURE_SIGNATURE_HEADER,
  fixtureSerializer,
  fixtureSignature,
} from './fixture-carrier-media.ts';
import {
  HANGUP_MARKUP,
  fixtureCarrierRoutes,
  fixtureStatusOf,
  formParams,
  signedPayload,
} from './fixture-carrier-routes.ts';

export * from './fixture-carrier-media.ts';
export {
  FIXTURE_STATUS_MAP,
  HANGUP_MARKUP,
  fixtureStatusOf,
  signedPayload,
  streamMarkup,
} from './fixture-carrier-routes.ts';

export const FIXTURE_API = 'https://fixture.invalid/v1';

export function fixtureCarrierCapabilities(
  mode: 'at-dial' | 'on-answer' = 'at-dial',
): CarrierCapabilities {
  return {
    carrierId: FIXTURE_CARRIER_ID,
    media: {
      formats: [MULAW_8K],
      playbackEvidence: 'carrier-played',
      clear: true,
      clearFlushesMarkers: true,
      dtmf: true,
      queryOnMediaUrl: false,
    },
    control: {
      callIdTiming: mode === 'at-dial' ? 'at-dial' : 'after-answer',
      streamParams: mode,
      streamCallIdMatchesDial: true,
      cancelBeforeAnswer: mode === 'on-answer',
      handoff: ['phone', 'end'],
      amd: 'async',
      maxDuration: true,
      reconcile: mode === 'at-dial' ? 'by-call-id' : 'by-request-id',
      hangup: 'rest',
    },
    continuation: 'markup-after-stream',
    webhookAuth: 'hmac-signature',
    pacing: { cps: 1 },
  };
}

/** A Twilio-shaped reference CarrierIngress; `on-answer` mode serves stream parameters from `answer`. */
export function fixtureCarrierIngress(mode: 'at-dial' | 'on-answer' = 'at-dial'): CarrierIngress {
  const routes = fixtureCarrierRoutes().filter(
    (route) => mode === 'on-answer' || route.purpose !== 'answer',
  );
  return {
    carrierId: FIXTURE_CARRIER_ID,
    capabilities: fixtureCarrierCapabilities(mode),
    serializer: fixtureSerializer,
    routes,
    operatorUrls: [
      { purpose: 'inbound', label: 'Inbound webhook', help: 'Paste into the fixture number.' },
      { purpose: 'media', label: 'Media stream', help: 'Issued per call; never pasted.' },
    ],
  };
}

const rejectMedia = (requestId: string, reason: string): DialResult => ({
  kind: 'rejected',
  requestId,
  reason,
  retryable: false,
});

/** REST control over `net` against https://fixture.invalid/v1 (FixtureNet in tests). */
export function fixtureCarrierControl(
  net: Pick<NetPort, 'fetch'>,
  mode: 'at-dial' | 'on-answer' = 'at-dial',
): CarrierControlFactory {
  const capabilities = fixtureCarrierCapabilities(mode);
  return {
    capabilities,
    create(binding: ResolvedBinding): TelephonyControl {
      const auth = { authorization: `Bearer ${binding.secret}` };
      const call = (method: string, path: string, form?: Record<string, string>) =>
        httpJson(
          net,
          `${FIXTURE_API}${path}`,
          { method, headers: auth, ...(form ? { form } : {}) },
          { timeoutMs: 5000 },
        );
      return {
        async dial(request) {
          const media = new URL(request.media.url);
          if (media.protocol !== 'wss:')
            return rejectMedia(request.requestId, 'media url must be wss');
          if (media.search)
            return rejectMedia(request.requestId, 'media url must not carry a query');
          const result = await call('POST', '/calls', {
            To: request.to,
            From: request.from,
            StatusCallback: request.callbacks.status,
            TimeLimit: String(request.maxDurationSec + 30),
            ...(mode === 'at-dial'
              ? { StreamUrl: request.media.url, ...prefixed(request.media.routeParams) }
              : { AnswerUrl: request.callbacks.answer }),
          });
          if (result.kind === 'ok') {
            const id = String(result.body.id ?? '');
            return mode === 'at-dial'
              ? { kind: 'accepted', requestId: request.requestId, carrierCallId: id }
              : { kind: 'accepted', requestId: request.requestId, carrierRequestId: id };
          }
          if (result.kind === 'rejected')
            return {
              kind: 'rejected',
              requestId: request.requestId,
              reason: result.reason,
              retryable: result.retryable,
            };
          return { kind: 'unknown', requestId: request.requestId, reason: result.reason };
        },
        async reconcile(query) {
          const id = query.carrierCallId ?? query.carrierRequestId;
          if (!id) return { kind: 'pending' };
          const result = await call('GET', `/calls/${encodeURIComponent(id)}`);
          if (result.kind === 'rejected')
            return result.status === 404
              ? { kind: 'pending' }
              : { kind: 'rejected', reason: result.reason };
          if (result.kind !== 'ok') return { kind: 'pending' };
          const state = fixtureStatusOf(String(result.body.status ?? ''));
          if (!state) return { kind: 'pending' };
          if (state === 'queued' || state === 'ringing' || state === 'in_progress')
            return { kind: 'live', carrierCallId: id, state };
          return { kind: 'ended', carrierCallId: id, state };
        },
        async hangup(query) {
          const result = query.carrierCallId
            ? await call('POST', `/calls/${encodeURIComponent(query.carrierCallId)}`, {
                Status: 'completed',
              })
            : query.carrierRequestId && mode === 'on-answer'
              ? await call('DELETE', `/requests/${encodeURIComponent(query.carrierRequestId)}`)
              : undefined;
          if (!result) return 'unsupported';
          if (result.kind === 'ok') return 'ended';
          if (result.kind === 'rejected' && result.status === 404) return 'already_ended';
          throw new Error(`fixture hangup ${result.kind}: ${result.reason}`);
        },
        async handoff(carrierCallId, target, requestId) {
          const markup =
            target.kind === 'phone'
              ? `<Dial>${target.e164}</Dial>`
              : `<Say>${target.kind === 'end' ? target.message : ''}</Say>${HANGUP_MARKUP}`;
          if (target.kind !== 'phone' && target.kind !== 'end')
            return {
              kind: 'rejected',
              retryable: false,
              reason: `unsupported handoff ${target.kind}`,
            };
          const result = await call('POST', `/calls/${encodeURIComponent(carrierCallId)}`, {
            Markup: markup,
            RequestId: requestId,
          });
          if (result.kind === 'ok')
            return { kind: 'confirmed', receiptId: String(result.body.id ?? requestId) };
          if (result.kind === 'rejected')
            return { kind: 'rejected', retryable: result.retryable, reason: result.reason };
          return { kind: 'unknown', reason: result.reason };
        },
      };
    },
  };
}

function prefixed(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [`Param_${key}`, value]));
}

/** Signs a fixture carrier webhook the way the fixture carrier verifies it. */
export function signFixtureRequest(
  secret: string,
  request: CarrierHttpRequest,
): CarrierHttpRequest {
  const query = new URLSearchParams(request.query).toString();
  const url = query ? `${request.externalUrl}?${query}` : request.externalUrl;
  const signature = fixtureSignature(secret, signedPayload(url, formParams(request)));
  return { ...request, headers: { ...request.headers, [FIXTURE_SIGNATURE_HEADER]: signature } };
}

/** A form-encoded POST to a fixture carrier route. */
export function fixtureWebhook(input: {
  externalUrl: string;
  bindingId: string;
  query?: Record<string, string>;
  form?: Record<string, string>;
}): CarrierHttpRequest {
  return {
    method: 'POST',
    externalUrl: input.externalUrl,
    query: input.query ?? {},
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    rawBody: new TextEncoder().encode(new URLSearchParams(input.form ?? {}).toString()),
    bindingId: input.bindingId,
  };
}
