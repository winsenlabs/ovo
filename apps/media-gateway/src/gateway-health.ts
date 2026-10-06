import { timingSafeEqual } from 'node:crypto';
import { timeoutOf } from '@winsendotai/ovo-contracts';

const MAX_REJECTIONS = 20;
const MAX_REASONS = 50;
const DB_TIMEOUT_MS = 1_000;
/** The dispatcher publishes inbound readiness every few seconds; older than this, it is stale. */
const READINESS_MAX_AGE_MS = 30_000;

export interface GatewayHealthOptions {
  pool: { query(sql: string): Promise<{ rows: unknown[] }> };
  /** Throws while no carrier ingress is armed for inbound admission. */
  assertArmed(): void;
  now?: () => number;
}

/**
 * What the gateway knows about the live path, for its token-protected `/health?verbose=1`
 * (OBS-12): database reachability, whether inbound admission is armed and what the dispatcher last
 * published about protected inbound capacity, admission decisions, the last refused admissions,
 * and how carrier sessions closed, with timeouts counted by stage (OBS-9).
 */
export class GatewayHealth {
  private readonly decisions = new Map<string, number>();
  private readonly closes = new Map<string, number>();
  private readonly timeouts = new Map<string, number>();
  private readonly rejections: { at: string; carrierCallId?: string; reason: string }[] = [];
  private readonly now: () => number;

  constructor(private readonly options: GatewayHealthOptions) {
    this.now = options.now ?? Date.now;
  }

  admission(kind: string): void {
    this.decisions.set(kind, (this.decisions.get(kind) ?? 0) + 1);
  }

  rejection(reason: string, carrierCallId?: string): void {
    this.rejections.push({
      at: new Date(this.now()).toISOString(),
      ...(carrierCallId ? { carrierCallId } : {}),
      reason: reason.slice(0, 300),
    });
    if (this.rejections.length > MAX_REJECTIONS) this.rejections.shift();
  }

  sessionClosed(reason: string): void {
    const timeout = timeoutOf(reason.startsWith('error:') ? reason : `error:${reason}`);
    if (timeout) {
      const key = timeout.provider ? `${timeout.stage}:${timeout.provider}` : timeout.stage;
      this.timeouts.set(key, (this.timeouts.get(key) ?? 0) + 1);
    }
    const code = reason.split(':', 2).join(':').slice(0, 100);
    if (this.closes.has(code) || this.closes.size < MAX_REASONS)
      this.closes.set(code, (this.closes.get(code) ?? 0) + 1);
  }

  async snapshot(): Promise<Record<string, unknown>> {
    const [database, readiness] = await Promise.all([this.database(), this.readiness()]);
    let armed = true;
    try {
      this.options.assertArmed();
    } catch {
      // swallow-ok: not armed is the answer this health field reports, not a failure.
      armed = false;
    }
    return {
      database,
      inbound: { armed, readiness },
      admissions: Object.fromEntries(this.decisions),
      lastRejections: [...this.rejections],
      closeReasons: Object.fromEntries(this.closes),
      timeouts: Object.fromEntries(this.timeouts),
    };
  }

  private async database(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const started = this.now();
    try {
      await bounded(this.options.pool.query('SELECT 1'), 'database ping timed out');
      return { ok: true, latencyMs: this.now() - started };
    } catch (error) {
      return {
        ok: false,
        latencyMs: this.now() - started,
        error: error instanceof Error ? error.message.slice(0, 200) : 'database unavailable',
      };
    }
  }

  private async readiness(): Promise<Record<string, unknown> | null> {
    try {
      const result = await bounded(
        this.options.pool.query(
          `SELECT signal, extract(epoch FROM (now() - signal_at))*1000 AS age_ms
             FROM ovo_capacity_signal_latest WHERE service_key = 'inbound-readiness'`,
        ),
        'inbound readiness read timed out',
      );
      const row = result.rows[0] as { signal: Record<string, unknown>; age_ms: string } | undefined;
      if (!row) return null;
      const ageMs = Math.max(0, Math.round(Number(row.age_ms)));
      const { ready, readyProtected, warmFloor, reasons } = row.signal;
      return {
        ready,
        readyProtected,
        warmFloor,
        reasons,
        ageMs,
        stale: ageMs > READINESS_MAX_AGE_MS,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message.slice(0, 200) : 'unavailable' };
    }
  }
}

/** A health read that hangs (pool exhausted, lock wait) must not hang the health probe. */
async function bounded<T>(query: Promise<T>, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      query,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), DB_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** `OVO_HEALTH_TOKEN` as a bearer token, compared in constant time; no token means no verbose. */
export function healthTokenMatches(header: string | string[] | undefined, token?: string): boolean {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
