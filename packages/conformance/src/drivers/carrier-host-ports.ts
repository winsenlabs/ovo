import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CarrierHostPorts,
  CarrierHttpRoute,
  InboundDecision,
  NormalizedCallEvent,
  ResolvedBinding,
  StreamGrant,
} from '@winsendotai/ovo-contracts';

type Purpose = CarrierHttpRoute['purpose'] | 'media';
type StreamResult = StreamGrant | { kind: 'ended' } | { kind: 'unmatched' };

export interface FakeHostPortsOptions {
  /** Defaults to one binding `b1` for carrier `fixture` with secret `fixture-secret`. */
  bindings?: Record<string, ResolvedBinding>;
  publicBaseUrl?: string;
  routeSecret?: string;
  streamForDial?:
    StreamResult | ((query: Parameters<CarrierHostPorts['streamForDial']>[0]) => StreamResult);
  resumeStream?: StreamGrant | { kind: 'ended' };
  admitInbound?: InboundDecision;
  /** Force url-secret verification to one answer (for negative vectors). */
  verifyUrlSecret?: boolean;
}

export interface FakeHostPorts extends CarrierHostPorts {
  readonly calls: readonly { method: string; args: unknown }[];
  readonly events: readonly NormalizedCallEvent[];
  /** The url-secret `t` for a purpose (and request id), as `callbackUrl` embeds it. */
  urlSecret(carrierId: string, bindingId: string, purpose: Purpose, requestId?: string): string;
  setVerifyUrlSecret(value: boolean | undefined): void;
}

export function fakeBinding(overrides: Partial<ResolvedBinding> = {}): ResolvedBinding {
  return {
    bindingId: 'b1',
    pluginId: '@winsendotai/ovo-carrier-fixture',
    workspaceId: 'w1',
    config: {},
    secret: 'fixture-secret',
    ...overrides,
  };
}

/** CarrierHostPorts for carrier tests: HMAC url-secrets, a recorded call log, scripted grants. */
export function createFakeCarrierHostPorts(options: FakeHostPortsOptions = {}): FakeHostPorts {
  const base = new URL(options.publicBaseUrl ?? 'https://ovo.example.test');
  const secret = options.routeSecret ?? 'fixture-route-secret';
  const bindings = options.bindings ?? { b1: fakeBinding() };
  const calls: { method: string; args: unknown }[] = [];
  const events: NormalizedCallEvent[] = [];
  let forced = options.verifyUrlSecret;
  const sign = (carrierId: string, bindingId: string, purpose: Purpose, requestId?: string) =>
    createHmac('sha256', secret)
      .update([carrierId, bindingId, purpose, ...(requestId ? [requestId] : [])].join(':'))
      .digest('base64url');
  const log = (method: string, args: unknown) => calls.push({ method, args });

  const ports: FakeHostPorts = {
    calls,
    events,
    urlSecret: sign,
    setVerifyUrlSecret(value) {
      forced = value;
    },
    async resolveBinding(bindingId) {
      log('resolveBinding', bindingId);
      const binding = bindings[bindingId];
      if (!binding) throw new Error(`unknown binding ${bindingId}`);
      return binding;
    },
    async admitInbound(admission) {
      log('admitInbound', admission);
      return (
        options.admitInbound ?? {
          kind: 'connect',
          mediaUrl: ports.mediaUrl(admission.carrierId, admission.bindingId),
          routeParams: { sid: 'session-inbound', rt: 'route-token-inbound' },
        }
      );
    },
    async confirmCallback(admission) {
      log('confirmCallback', admission);
      return { kind: 'hangup' };
    },
    async applyCallEvent(event) {
      log('applyCallEvent', event);
      events.push(event);
      return { kind: 'applied' };
    },
    async streamForDial(query) {
      log('streamForDial', query);
      const configured = options.streamForDial;
      if (typeof configured === 'function') return configured(query);
      return (
        configured ?? {
          kind: 'stream',
          mediaUrl: ports.mediaUrl(query.carrierId, query.bindingId),
          routeParams: { sid: 'session-1', rt: 'route-token-1' },
          resumeUrl: ports.callbackUrl(query.carrierId, query.bindingId, 'resume', {
            requestId: query.dialRequestId ?? 'session-1',
          }),
        }
      );
    },
    async resumeStream(query) {
      log('resumeStream', query);
      return options.resumeStream ?? { kind: 'ended' };
    },
    mediaUrl(carrierId, bindingId, opts) {
      const url = new URL(`/carriers/${carrierId}/${bindingId}/media`, base);
      url.protocol = 'wss:';
      for (const [key, value] of Object.entries(opts?.query ?? {}))
        url.searchParams.set(key, value);
      return url.href;
    },
    callbackUrl(carrierId, bindingId, purpose, opts) {
      const url = new URL(`/carriers/${carrierId}/${bindingId}/${purpose}`, base);
      if (opts?.requestId) url.searchParams.set('r', opts.requestId);
      url.searchParams.set('t', sign(carrierId, bindingId, purpose, opts?.requestId));
      return url.href;
    },
    verifyUrlSecret(request, opts) {
      log('verifyUrlSecret', { purpose: opts.purpose, requestId: opts.requestId });
      if (forced !== undefined) return forced;
      const carrierId = /\/carriers\/([^/]+)\//.exec(new URL(request.externalUrl).pathname)?.[1];
      const token = request.query.t;
      if (!carrierId || !token) return false;
      const expected = Buffer.from(
        sign(carrierId, request.bindingId, opts.purpose, opts.requestId),
      );
      const actual = Buffer.from(token);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  };
  return ports;
}
