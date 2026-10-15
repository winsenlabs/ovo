export type Health = { ok: true } | { ok: false; reason: string };

const OK_TTL_MS = 5_000;
const FAIL_TTL_MS = 2_000;
const PROBE_TIMEOUT_MS = 2_000;

/**
 * A cached, single-flight health probe. The router asks before every human handoff, so a down
 * room server must cost one probe per few seconds, not one per call.
 */
export class CachedHealth {
  private cached?: { at: number; value: Health };
  private inflight?: Promise<Health>;

  constructor(
    private readonly probe: (signal: AbortSignal) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async check(signal: AbortSignal): Promise<Health> {
    const hit = this.cached;
    if (hit && this.now() - hit.at < (hit.value.ok ? OK_TTL_MS : FAIL_TTL_MS)) return hit.value;
    this.inflight ??= this.run().finally(() => (this.inflight = undefined));
    // A caller giving up does not cancel the shared probe; it just stops waiting for it.
    if (signal.aborted) return { ok: false, reason: 'aborted' };
    let onAbort!: () => void;
    const aborted = new Promise<Health>((resolve) => {
      onAbort = () => resolve({ ok: false, reason: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([this.inflight, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async run(): Promise<Health> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let value: Health;
    try {
      await Promise.race([
        this.probe(controller.signal),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('timeout')), {
            once: true,
          }),
        ),
      ]);
      value = { ok: true };
    } catch (error) {
      value = { ok: false, reason: reasonOf(error) };
    } finally {
      clearTimeout(timer);
    }
    this.cached = { at: this.now(), value };
    return value;
  }
}

/** A short code, never the server's message (it can carry a URL). */
function reasonOf(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return 'unauthorized';
  if (typeof status === 'number') return `http_${status}`;
  return (error as Error | null)?.message === 'timeout' ? 'timeout' : 'unreachable';
}
