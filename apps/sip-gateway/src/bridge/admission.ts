import type { SipInboundRequest } from '@winsendotai/ovo-sip-carrier-kit';
import { z } from 'zod';
import { carrierPath, signedPost, type BridgeTarget } from './signed-http.ts';

/** The parts of the host's `InboundDecision` the sip-gateway acts on. */
const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('connect'),
    mediaUrl: z.string().startsWith('wss://'),
    routeParams: z.record(z.string(), z.string()),
    resumeUrl: z.string().optional(),
    statusUrl: z.string().optional(),
  }),
  z.object({
    kind: z.literal('wait'),
    pauseSeconds: z.number().min(0).max(300),
    retryUrl: z.string(),
  }),
  z.object({ kind: z.literal('callback-offer') }),
  z.object({ kind: z.literal('human'), e164: z.string() }),
  z.object({ kind: z.literal('busy') }),
  z.object({ kind: z.literal('reject'), reason: z.string().optional() }),
  z.object({ kind: z.literal('hangup') }),
]);

export interface StreamGrant {
  mediaUrl: string;
  routeParams: Record<string, string>;
  resumeUrl?: string;
  statusUrl?: string;
}

export type AdmissionOutcome =
  | { kind: 'connect'; grant: StreamGrant; decisionMs: number }
  | { kind: 'refuse'; status: number; reason: string; decisionMs: number };

/**
 * Decisions without a SIP-only equivalent (W11 §21): a callback offer needs a prompt and DTMF
 * before answer, and a human transfer needs the B2BUA path, so both refuse the call.
 */
const REFUSALS: Readonly<Record<string, { status: number; reason: string }>> = {
  busy: { status: 486, reason: 'busy' },
  reject: { status: 603, reason: 'rejected' },
  hangup: { status: 480, reason: 'hangup' },
  'callback-offer': { status: 486, reason: 'callback_offer_unsupported' },
  human: { status: 480, reason: 'human_unsupported' },
};

export interface AdmitOptions {
  target: BridgeTarget;
  carrierId: string;
  bindingId: string;
  request: Omit<SipInboundRequest, 'retry' | 'v'>;
  /** Cap on time spent in `wait` decisions (OVO_SIP_INBOUND_WAIT_MAX_MS). */
  waitMaxMs: number;
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** CANCEL before the decision: stop asking. */
  signal: AbortSignal;
}

/** `POST inbound`, following `wait` retries until `connect`, a refusal, the cap or a CANCEL. */
export async function admit(options: AdmitOptions): Promise<AdmissionOutcome> {
  const started = options.now();
  const done = (outcome: { status: number; reason: string }): AdmissionOutcome => ({
    kind: 'refuse',
    ...outcome,
    decisionMs: options.now() - started,
  });
  let path = `/carriers/${options.carrierId}/${encodeURIComponent(options.bindingId)}/inbound`;
  for (let retry = 0; ; retry += 1) {
    if (options.signal.aborted) return done({ status: 487, reason: 'cancelled' });
    let reply: { status: number; json: unknown };
    try {
      reply = await signedPost(options.target, path, { v: 1, ...options.request, retry });
    } catch {
      return done({ status: 503, reason: 'admission_unreachable' });
    }
    if (reply.status !== 200)
      return done({ status: 503, reason: `admission_http_${reply.status}` });
    const decision = DecisionSchema.safeParse(reply.json);
    if (!decision.success) return done({ status: 500, reason: 'admission_malformed' });
    const d = decision.data;
    if (d.kind === 'connect') {
      const { kind: _kind, ...grant } = d;
      return { kind: 'connect', grant, decisionMs: options.now() - started };
    }
    if (d.kind !== 'wait') return done(REFUSALS[d.kind]!);
    if (options.now() - started + d.pauseSeconds * 1000 > options.waitMaxMs)
      return done({ status: 486, reason: 'wait_expired' });
    try {
      path = carrierPath(d.retryUrl);
      await options.sleep(d.pauseSeconds * 1000, options.signal);
    } catch {
      return done(
        options.signal.aborted
          ? { status: 487, reason: 'cancelled' }
          : { status: 500, reason: 'admission_malformed' },
      );
    }
  }
}
