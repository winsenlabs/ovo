import type { Clock } from '@winsendotai/ovo-contracts';
import type { SipHandoffResponse, SipReconcileResponse } from '@winsendotai/ovo-sip-carrier-kit';
import type { Call } from './call.ts';

/** How long an outbound request stays answerable by `GET /v1/calls?requestId` (§5.4). */
export const RECONCILE_TTL_MS = 60 * 60 * 1000;
const MAX_RECONCILE = 10_000;
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const MAX_HANDOFFS = 1_000;

type Entry = { response: SipReconcileResponse; expires: number };

/**
 * Live calls by Call-ID, and the reconcile table: requestId → what the host should believe about
 * that dial, kept for an hour after the call ended.
 */
export class CallRegistry {
  private readonly calls = new Map<string, Call>();
  private readonly requests = new Map<string, Entry>();
  private readonly handoffs = new Map<string, { response: SipHandoffResponse; expires: number }>();

  constructor(private readonly clock: Clock) {}

  get size(): number {
    return this.calls.size;
  }

  add(call: Call): void {
    this.calls.set(call.callId, call);
  }

  get(callId: string | undefined): Call | undefined {
    return callId === undefined ? undefined : this.calls.get(callId);
  }

  remove(callId: string): void {
    this.calls.delete(callId);
  }

  all(): Call[] {
    return [...this.calls.values()];
  }

  /** Live calls on one trunk (the per-trunk concurrency limit). */
  onTrunk(trunkId: string): number {
    let count = 0;
    for (const call of this.calls.values()) if (call.trunk.id === trunkId) count += 1;
    return count;
  }

  byRequest(requestId: string): Call | undefined {
    for (const call of this.calls.values()) if (call.dialRequestId === requestId) return call;
    return undefined;
  }

  /** Records what reconcile answers for `requestId` from now on. */
  record(requestId: string, response: SipReconcileResponse): void {
    const now = this.clock.now();
    for (const [key, entry] of this.requests) {
      if (entry.expires > now && this.requests.size < MAX_RECONCILE) break;
      this.requests.delete(key);
    }
    this.requests.delete(requestId);
    this.requests.set(requestId, { response, expires: now + RECONCILE_TTL_MS });
  }

  /** A handoff that left the call (confirmed or unknown), kept so a retried request gets the same answer. */
  rememberHandoff(requestId: string, response: SipHandoffResponse): void {
    const now = this.clock.now();
    for (const [key, entry] of this.handoffs) {
      if (entry.expires > now && this.handoffs.size < MAX_HANDOFFS) break;
      this.handoffs.delete(key);
    }
    this.handoffs.set(requestId, { response, expires: now + HANDOFF_TTL_MS });
  }

  handoffFor(requestId: string): SipHandoffResponse | undefined {
    const entry = this.handoffs.get(requestId);
    return entry && entry.expires > this.clock.now() ? entry.response : undefined;
  }

  reconcile(requestId: string): SipReconcileResponse {
    const entry = this.requests.get(requestId);
    if (!entry || entry.expires <= this.clock.now())
      return { kind: 'rejected', reason: 'unknown_request' };
    return entry.response;
  }
}
