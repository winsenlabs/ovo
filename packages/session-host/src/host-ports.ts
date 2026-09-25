import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CarrierHostPorts,
  InboundAdmission,
  InboundDecision,
  NormalizedCallEvent,
  ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { resumeStream, streamForDial, type StreamGrantStore } from './stream-grants.ts';

export interface CarrierHostPortsOptions {
  publicBaseUrl: string;
  routeSecret: string | Uint8Array;
  operations: {
    admitInbound(admission: InboundAdmission): Promise<InboundDecision>;
    confirmCallback(admission: InboundAdmission & { digits: string }): Promise<InboundDecision>;
  };
  orchestration: StreamGrantStore & {
    applyCallEvent(event: NormalizedCallEvent): Promise<{
      kind: 'applied' | 'duplicate' | 'unmatched' | 'correlation_conflict';
    }>;
  };
  bindings: (id: string, carrierId?: string) => Promise<ResolvedBinding>;
  /** Scope one host-port instance to a carrier when the reserved env binding is used. */
  carrierId?: string;
  /** Only carriers declaring queryOnMediaUrl may receive opts.query. */
  queryOnMediaUrl?: (carrierId: string) => boolean;
  /** Carrier capability used to decide whether a differing stream call ID needs an audit. */
  streamCallIdMatchesDial?: (carrierId: string) => boolean | 'unknown';
  clock?: { now(): number };
  workerFreshSeconds?: number;
}

/** Host-built carrier URLs and single-use grants. No carrier receives the route secret. */
export function createCarrierHostPorts(options: CarrierHostPortsOptions): CarrierHostPorts {
  const base = new URL(options.publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new Error('Carrier public base URL must be https without credentials or query');
  if (Buffer.from(options.routeSecret).byteLength < 32)
    throw new Error('Carrier route secret must be at least 32 bytes');
  const now = () => options.clock?.now() ?? Date.now();
  const sign = (carrierId: string, bindingId: string, purpose: string, requestId?: string) =>
    createHmac('sha256', options.routeSecret)
      .update(`${carrierId}:${bindingId}:${purpose}${requestId ? `:${requestId}` : ''}`)
      .digest('hex');
  const equal = (actual: string, expected: string) => {
    const left = Buffer.from(actual, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  };
  const path = (carrierId: string, bindingId: string, purpose: string) =>
    `/carriers/${encodeURIComponent(carrierId)}/${encodeURIComponent(bindingId)}/${purpose}`;
  const callbackUrl: CarrierHostPorts['callbackUrl'] = (carrierId, bindingId, purpose, opts) => {
    const url = new URL(base);
    url.pathname = path(carrierId, bindingId, purpose);
    url.search = '';
    if (opts?.requestId) url.searchParams.set('r', opts.requestId);
    url.searchParams.set('t', sign(carrierId, bindingId, purpose, opts?.requestId));
    return url.href;
  };
  const mediaUrl: CarrierHostPorts['mediaUrl'] = (carrierId, bindingId, opts) => {
    if (opts?.query && !options.queryOnMediaUrl?.(carrierId))
      throw new Error(`Carrier ${carrierId} does not permit media URL queries`);
    const url = new URL(base);
    url.protocol = 'wss:';
    url.pathname = path(carrierId, bindingId, 'media');
    url.search = '';
    for (const [key, value] of Object.entries(opts?.query ?? {})) url.searchParams.set(key, value);
    return url.href;
  };
  const urls = {
    mediaUrl: (carrierId: string, bindingId: string) => mediaUrl(carrierId, bindingId),
    callbackUrl: (
      carrierId: string,
      bindingId: string,
      purpose: 'resume' | 'status',
      requestId: string,
    ) => callbackUrl(carrierId, bindingId, purpose, { requestId }),
  };
  return {
    resolveBinding: (bindingId) => options.bindings(bindingId, options.carrierId),
    admitInbound: (admission) => options.operations.admitInbound(admission),
    confirmCallback: (admission) => options.operations.confirmCallback(admission),
    applyCallEvent: (event) => options.orchestration.applyCallEvent(event),
    mediaUrl,
    callbackUrl,
    verifyUrlSecret(req, check) {
      try {
        const url = new URL(req.externalUrl);
        if (url.protocol !== 'https:' || url.host !== base.host) return false;
        const parts = url.pathname.split('/');
        if (parts.length !== 5 || parts[1] !== 'carriers') return false;
        const carrierId = decodeURIComponent(parts[2]!);
        const bindingId = decodeURIComponent(parts[3]!);
        if (bindingId !== req.bindingId || parts[4] !== check.purpose) return false;
        const requestId = check.requestId ?? req.query.r;
        if (check.requestId && req.query.r !== check.requestId) return false;
        const actual = req.query.t;
        return (
          typeof actual === 'string' &&
          equal(actual, sign(carrierId, bindingId, check.purpose, requestId))
        );
      } catch {
        return false;
      }
    },
    async streamForDial(query) {
      const binding = await options.bindings(query.bindingId, query.carrierId);
      if (!binding.workspaceId) return { kind: 'unmatched' };
      return streamForDial(
        options.orchestration,
        { ...query, organizationId: binding.workspaceId },
        urls,
        now,
        options.streamCallIdMatchesDial?.(query.carrierId),
      );
    },
    async resumeStream(query) {
      const binding = await options.bindings(query.bindingId, query.carrierId);
      if (!binding.workspaceId) return { kind: 'ended' };
      return resumeStream(
        options.orchestration,
        { ...query, organizationId: binding.workspaceId },
        urls,
        now,
        options.workerFreshSeconds ?? 30,
      );
    },
  };
}
