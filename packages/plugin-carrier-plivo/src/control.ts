import { httpJson } from '@winsendotai/ovo-plugin-kit';
import type {
  CarrierControlFactory,
  DialResult,
  NetPort,
  ResolvedBinding,
  TelephonyControl,
} from '@winsendotai/ovo-contracts';
import { plivoCapabilities } from './plugin.ts';
import { plivoCdrStatus, plivoStatus } from './status-map.ts';

function authIdOf(binding: ResolvedBinding): string {
  const id = binding.config.authId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]+$/.test(id))
    throw new Error('Plivo authId must be alphanumeric');
  return id;
}

function rejected(requestId: string, reason: string): DialResult {
  return { kind: 'rejected', requestId, reason, retryable: false };
}

export function plivoControl(net: Pick<NetPort, 'fetch'>): CarrierControlFactory {
  return {
    capabilities: plivoCapabilities,
    create(binding: ResolvedBinding): TelephonyControl {
      const authId = authIdOf(binding);
      const base = `https://api.plivo.com/v1/Account/${authId}`;
      const auth = `Basic ${Buffer.from(`${authId}:${binding.secret}`).toString('base64')}`;
      const call = (method: string, path: string, json?: Record<string, unknown>) =>
        httpJson(
          net,
          `${base}${path}`,
          {
            method,
            headers: { authorization: auth },
            ...(json ? { json } : {}),
          },
          { timeoutMs: 5_000 },
        );
      return {
        async dial(request) {
          let media: URL;
          try {
            media = new URL(request.media.url);
          } catch {
            return rejected(request.requestId, 'media URL is invalid');
          }
          if (
            media.protocol !== 'wss:' ||
            media.search ||
            media.hash ||
            media.username ||
            media.password
          )
            return rejected(request.requestId, 'media URL must be WSS without a query');
          if (Object.keys(request.media.routeParams).length)
            return rejected(request.requestId, 'Plivo stream params are obtained on answer');
          const answer = new URL(request.callbacks.answer);
          if (answer.searchParams.get('r') !== request.requestId)
            return rejected(request.requestId, 'answer URL must carry the dial request id');
          const body: Record<string, unknown> = {
            from: request.from,
            to: request.to,
            answer_url: request.callbacks.answer,
            answer_method: 'POST',
            hangup_url: request.callbacks.status,
            time_limit: request.maxDurationSec,
          };
          if (request.ringTimeoutSec) body.ring_timeout = request.ringTimeoutSec;
          if (request.amd && request.amd.mode !== 'off') {
            if (!request.callbacks.amd)
              return rejected(request.requestId, 'AMD callback URL is required');
            body.machine_detection = request.amd.mode === 'hangup-on-machine' ? 'hangup' : 'true';
            body.machine_detection_url = request.callbacks.amd;
            body.machine_detection_time = Math.max(
              2_000,
              Math.min(10_000, request.amd.timeoutMs ?? 5_000),
            );
          }
          const result = await call('POST', '/Call/', body);
          if (result.kind === 'rejected')
            return {
              kind: 'rejected',
              requestId: request.requestId,
              reason: result.reason,
              retryable: result.retryable,
            };
          if (result.kind === 'unknown')
            return { kind: 'unknown', requestId: request.requestId, reason: result.reason };
          const id = result.body.request_uuid;
          if (result.status !== 201 || typeof id !== 'string' || !id)
            return {
              kind: 'unknown',
              requestId: request.requestId,
              reason: 'Plivo accepted a call without request_uuid',
            };
          return { kind: 'accepted', requestId: request.requestId, carrierRequestId: id };
        },
        async reconcile(query) {
          // Plivo documents no request_uuid → call_uuid lookup. The answer/status callback
          // supplies CallUUID; before that, report pending rather than guessing a call.
          if (!query.carrierCallId) return { kind: 'pending' };
          const path = `/Call/${encodeURIComponent(query.carrierCallId)}/`;
          const live = await call('GET', `${path}?status=live`);
          if (live.kind === 'ok') {
            const state = plivoStatus(String(live.body.call_status ?? ''));
            if (state !== 'queued' && state !== 'ringing' && state !== 'in_progress')
              return { kind: 'pending' };
            return { kind: 'live', carrierCallId: query.carrierCallId, state };
          }
          if (live.kind !== 'rejected' || live.status !== 404) return { kind: 'pending' };
          const cdr = await call('GET', path);
          if (cdr.kind !== 'ok') return { kind: 'pending' };
          if (typeof cdr.body.end_time !== 'string' || !cdr.body.end_time)
            return { kind: 'pending' };
          const state = plivoCdrStatus(String(cdr.body.hangup_cause_name ?? ''));
          if (!state) return { kind: 'pending' };
          return {
            kind: 'ended',
            carrierCallId: query.carrierCallId,
            state,
          };
        },
        async hangup(query) {
          const path = query.carrierCallId
            ? `/Call/${encodeURIComponent(query.carrierCallId)}/`
            : query.carrierRequestId
              ? `/Request/${encodeURIComponent(query.carrierRequestId)}/`
              : undefined;
          if (!path) return 'unsupported';
          const result = await call('DELETE', path);
          if (result.kind === 'ok' && result.status === 204) return 'ended';
          if (result.kind === 'rejected' && result.status === 404) return 'already_ended';
          throw new Error(
            `Plivo hangup ${result.kind}: ${
              result.kind === 'ok' ? `unexpected HTTP ${result.status}` : result.reason
            }`,
          );
        },
        async handoff(carrierCallId, target, requestId) {
          if (target.kind === 'end') {
            const result = await call('DELETE', `/Call/${encodeURIComponent(carrierCallId)}/`);
            if (result.kind === 'ok' && result.status === 204)
              return { kind: 'confirmed', receiptId: requestId };
            if (result.kind === 'rejected' && result.status === 404)
              return { kind: 'confirmed', receiptId: requestId };
            if (result.kind === 'ok')
              return { kind: 'unknown', reason: `Unexpected Plivo end status ${result.status}` };
            if (result.kind === 'rejected')
              return { kind: 'rejected', retryable: result.retryable, reason: result.reason };
            return { kind: 'unknown', reason: result.reason };
          }
          return {
            kind: 'rejected',
            retryable: false,
            reason: `Plivo ${target.kind} handoff needs a host-owned transfer XML URL`,
          };
        },
      };
    },
  };
}
