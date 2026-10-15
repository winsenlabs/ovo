import type {
  SignatureCheck,
  WebhookAttempt,
  WebhookOutcome,
  WebhookRequest,
} from '@winsendotai/ovo-session-host';

/**
 * What the human queue routes need from outside the API: the signed webhook client and signature
 * check (the session host's, shared with the worker so both agree byte for byte), a clock and a
 * rate limiter. Tests pass fakes; production passes `human-queue-egress.ts`.
 */
export type EgressRequest = WebhookRequest;
export type EgressAttempt = WebhookAttempt;
export type EgressOutcome = WebhookOutcome;
export type SignatureVerdict = SignatureCheck;

export interface HumanQueueEgress {
  send(request: EgressRequest, onAttempt: (attempt: EgressAttempt) => void): Promise<EgressOutcome>;
  /** The request as a preview shows it: no secret, no query, no credentials. */
  redact(request: EgressRequest): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };
  verify(input: {
    secret: string;
    timestamp: string | undefined;
    id: string | undefined;
    body: string;
    signature: string | undefined;
    now: number;
  }): SignatureVerdict;
}

/** A sliding-window counter per key. In-process: several API replicas need an edge limit as well. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit; false when `key` has already used its allowance in the window. */
  take(key: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys)
      this.hits.delete(this.hits.keys().next().value!);
    this.hits.set(key, [...recent, now]);
    return true;
  }

  /** Seconds until `key` may try again (0 when it may now). */
  retryAfterSeconds(key: string): number {
    const oldest = (this.hits.get(key) ?? []).find((at) => at > this.now() - this.windowMs);
    return oldest === undefined ? 0 : Math.ceil((oldest + this.windowMs - this.now()) / 1000);
  }
}
