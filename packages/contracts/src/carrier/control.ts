import type { AudioFormat } from '../audio.ts';
import type { CarrierCapabilities } from './capabilities.ts';

/** A carrier binding with its secret already resolved by the host. Carriers never resolve secrets. */
export interface ResolvedBinding {
  bindingId: string;
  pluginId: string;
  workspaceId: string;
  config: Record<string, unknown>;
  secret: string;
}

/** Capability `ovo.carrier.control` (cardinality many, keyed by `manifest.provider`). */
export interface CarrierControlFactory {
  readonly capabilities: CarrierCapabilities;
  create(binding: ResolvedBinding): TelephonyControl;
}

export interface DialRequest {
  requestId: string;
  jobId: string;
  to: string;
  from: string;
  media: {
    /** wss:, no query, host-built. */
    url: string;
    /** Empty for on-answer carriers. */
    routeParams: Record<string, string>;
    format: AudioFormat;
  };
  /** Host-built, binding-scoped, each with a per-call url-secret. */
  callbacks: { status: string; answer: string; amd?: string; resume?: string };
  amd?: { mode: 'off' | 'detect' | 'hangup-on-machine'; timeoutMs?: number };
  ringTimeoutSec?: number;
  maxDurationSec: number;
}

export type DialResult =
  | { kind: 'accepted'; requestId: string; carrierCallId?: string; carrierRequestId?: string }
  | { kind: 'rejected'; requestId: string; reason: string; retryable: boolean }
  | { kind: 'unknown'; requestId: string; reason: string };

export type CallState =
  'queued' | 'ringing' | 'in_progress' | 'completed' | 'busy' | 'no_answer' | 'failed' | 'canceled';

export type Reconciliation =
  | { kind: 'pending' }
  | { kind: 'live'; carrierCallId?: string; state: 'queued' | 'ringing' | 'in_progress' }
  | {
      kind: 'ended';
      carrierCallId?: string;
      state: Exclude<CallState, 'queued' | 'ringing' | 'in_progress'>;
      answeredBy?: 'human' | 'machine' | 'unknown';
    }
  | { kind: 'rejected'; reason: string };

export type HandoffTarget =
  | { kind: 'phone'; e164: string }
  | { kind: 'queue'; name: string }
  | { kind: 'resume' }
  | { kind: 'end'; message: string };

/** A request id cancels a call before answer on carriers with `cancelBeforeAnswer`. */
export interface HangupQuery {
  carrierCallId?: string;
  carrierRequestId?: string;
}

/** TelephonyControl v2. The legacy v1 interface stays in `plugin-orchestration` until wave 3. */
export interface TelephonyControl {
  /** MUST reject a non-wss or query-bearing `media.url` as non-retryable (#1). */
  dial(request: DialRequest): Promise<DialResult>;
  reconcile(query: {
    requestId: string;
    carrierCallId?: string;
    carrierRequestId?: string;
  }): Promise<Reconciliation>;
  /** 'unsupported' on close-stream carriers; the host then closes the media stream (§4.10). */
  hangup(query: HangupQuery): Promise<'ended' | 'already_ended' | 'unsupported'>;
  handoff(
    carrierCallId: string,
    target: HandoffTarget,
    requestId: string,
  ): Promise<
    | { kind: 'confirmed'; receiptId: string }
    | { kind: 'rejected'; retryable: boolean; reason: string }
    | { kind: 'unknown'; reason: string }
  >;
}
