import type { CarrierCapabilities } from './capabilities.ts';
import type { CallState, ResolvedBinding } from './control.ts';
import type { MediaSerializer } from './media.ts';

export interface CarrierHttpRequest {
  method: 'GET' | 'POST';
  externalUrl: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  rawBody: Uint8Array;
  bindingId: string;
  remoteAddress?: string;
}

export interface CarrierHttpReply {
  status: number;
  contentType: string;
  body: string;
}

export interface StreamGrant {
  kind: 'stream';
  mediaUrl: string;
  routeParams: Record<string, string>;
  resumeUrl?: string;
  statusUrl?: string;
}

export interface NormalizedCallEvent {
  carrierId: string;
  bindingId: string;
  eventId: string;
  carrierCallId?: string;
  carrierRequestId?: string;
  dialRequestId?: string;
  state: CallState;
  answeredBy?: 'human' | 'machine' | 'unknown';
  occurredAt: Date;
  payload?: Record<string, unknown>;
}

export interface InboundAdmission {
  carrierId: string;
  bindingId: string;
  carrierCallId: string;
  from: string;
  to: string;
  receivedAt: Date;
  raw?: Record<string, string>;
}

/**
 * Carrier-neutral inbound outcome, derived from what the gateway webhook and the operations
 * inbound gateway exchange today: reserved → connect, wait (announce once, then pause and retry),
 * callback prompt → callback-offer, human transfer, busy (incl. wait expiry), reject, hangup
 * (for example a settled callback request).
 */
export type InboundDecision =
  | ({ kind: 'connect' } & Omit<StreamGrant, 'kind'>)
  | { kind: 'wait'; message?: string; announce?: boolean; pauseSeconds: number; retryUrl: string }
  | { kind: 'callback-offer'; prompt: string; digitsUrl: string; timeoutSeconds: number }
  | { kind: 'human'; e164: string; message?: string; callerId?: string; timeoutSeconds?: number }
  | { kind: 'busy'; message?: string; reason?: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'hangup'; message?: string };

export interface CarrierHttpRoute {
  method: 'GET' | 'POST';
  purpose: 'inbound' | 'answer' | 'status' | 'amd' | 'stream-status' | 'resume' | 'media-url';
  /** Verifies the carrier's own auth (signature or url-secret) itself. */
  handle(req: CarrierHttpRequest, host: CarrierHostPorts): Promise<CarrierHttpReply>;
}

/** What the host gives carrier routes. Route tokens are minted only inside `streamForDial`/`resumeStream`. */
export interface CarrierHostPorts {
  resolveBinding(bindingId: string): Promise<ResolvedBinding>;
  admitInbound(admission: InboundAdmission): Promise<InboundDecision>;
  confirmCallback(admission: InboundAdmission & { digits: string }): Promise<InboundDecision>;
  applyCallEvent(
    event: NormalizedCallEvent,
  ): Promise<{ kind: 'applied' | 'duplicate' | 'unmatched' | 'correlation_conflict' }>;
  /**
   * On-answer carriers: correlate an outbound dial, bind the carrier call id (CAS where NULL, alias
   * if it differs), and mint a fresh single-use route token. 'ended' when the route is terminating.
   */
  streamForDial(query: {
    carrierId: string;
    bindingId: string;
    dialRequestId?: string;
    carrierCallId?: string;
    carrierRequestId?: string;
  }): Promise<StreamGrant | { kind: 'ended' } | { kind: 'unmatched' }>;
  /** Continuation: re-issue at generation+1 only while connected, not terminating, and owned. */
  resumeStream(query: {
    carrierId: string;
    bindingId: string;
    carrierCallId: string;
  }): Promise<StreamGrant | { kind: 'ended' }>;
  /** A query is added only for carriers with `queryOnMediaUrl`. */
  mediaUrl(carrierId: string, bindingId: string, opts?: { query?: Record<string, string> }): string;
  callbackUrl(
    carrierId: string,
    bindingId: string,
    purpose: CarrierHttpRoute['purpose'],
    opts?: { requestId?: string },
  ): string;
  verifyUrlSecret(
    req: CarrierHttpRequest,
    opts: { purpose: CarrierHttpRoute['purpose'] | 'media'; requestId?: string },
  ): boolean;
}

/** Capability `ovo.carrier.ingress` (cardinality many, keyed by `manifest.provider`). */
export interface CarrierIngress {
  readonly carrierId: string;
  readonly capabilities: CarrierCapabilities;
  readonly serializer: MediaSerializer;
  readonly routes: readonly CarrierHttpRoute[];
  /** Shown in the console, rendered through `callbackUrl`/`mediaUrl`. */
  readonly operatorUrls: readonly {
    purpose: CarrierHttpRoute['purpose'] | 'media';
    label: string;
    help: string;
  }[];
  readonly legacyPaths?: Readonly<
    Record<string, { purpose: CarrierHttpRoute['purpose'] | 'media'; bindingId: string }>
  >;
}
