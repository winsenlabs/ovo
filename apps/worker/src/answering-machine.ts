import {
  effectiveVoicemailPolicy,
  type AgentConfig,
  type CarrierCapabilities,
} from '@winsendotai/ovo-contracts';
import { createLogger, errorFields } from '@winsendotai/ovo-plugin-kit';

const logger = createLogger({ service: 'worker' });

export type AnsweredBy = 'human' | 'machine' | 'unknown';

/**
 * Whether this call asks the carrier to detect an answering machine, and how long a speak-first
 * opening waits for the verdict. The dial request and the session read this one answer, so the
 * engine never waits for a verdict nobody asked the carrier for.
 */
export function answeringMachineFor(
  config: AgentConfig,
  payload: Record<string, unknown>,
  capabilities: { control?: Pick<CarrierCapabilities['control'], 'amd'> },
): { timeoutMs: number } | undefined {
  if (payload.kind === 'inbound_call' || config.mode !== 'agent') return undefined;
  const policy = effectiveVoicemailPolicy(config);
  // A carrier that declares no control capabilities cannot detect a machine either.
  if (!policy || (capabilities.control?.amd ?? 'none') === 'none') return undefined;
  return { timeoutMs: policy.timeoutMs };
}

/** The carrier's verdict from any source, once: the first one wins, late subscribers still hear it. */
export class AnsweredByVerdicts {
  private value?: AnsweredBy;
  private readonly listeners = new Set<(value: AnsweredBy) => void>();

  get verdict(): AnsweredBy | undefined {
    return this.value;
  }

  deliver(value: AnsweredBy): void {
    if (this.value) return;
    this.value = value;
    for (const listener of [...this.listeners]) listener(value);
  }

  subscribe(listener: (value: AnsweredBy) => void): () => void {
    this.listeners.add(listener);
    const known = this.value;
    if (known) queueMicrotask(() => this.listeners.has(listener) && listener(known));
    return () => this.listeners.delete(listener);
  }
}

export interface AnsweredByWatch {
  pool: { query(sql: string, values: unknown[]): Promise<{ rows: { answered_by: string }[] }> };
  route: { sessionId: string; organizationId: string };
  deliver(value: AnsweredBy): void;
  /** How often the durable callback is read while an opening may be waiting on it. */
  intervalMs?: number;
  /** The opening's hold: read every `intervalMs` until then, every `slowIntervalMs` after. */
  fastForMs?: number;
  slowIntervalMs?: number;
  /** The carrier gives up long before this; the watch stops here regardless. */
  maxMs?: number;
}

/**
 * Reads the carrier's answering-machine callback from the durable callback table. The callback
 * lands on the media gateway, which records it but does not forward it over the media socket, and
 * can land on any gateway replica; the row is the one place every worker can see it.
 */
export function watchAnsweredBy(watch: AnsweredByWatch): () => void {
  const intervalMs = watch.intervalMs ?? 100;
  const started = Date.now();
  const fastUntil = started + (watch.fastForMs ?? Number.POSITIVE_INFINITY);
  const deadline = started + (watch.maxMs ?? 60_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reported = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const { rows } = await watch.pool.query(
        `SELECT payload->>'answeredBy' AS answered_by FROM ovo_carrier_callbacks
         WHERE session_id = $1 AND organization_id = $2 AND payload ? 'answeredBy'
         ORDER BY occurred_at, received_at LIMIT 1`,
        [watch.route.sessionId, watch.route.organizationId],
      );
      const value = rows[0]?.answered_by;
      if (!stopped && (value === 'human' || value === 'machine' || value === 'unknown')) {
        stopped = true;
        watch.deliver(value);
        return;
      }
    } catch (error) {
      // Reported once: a broken read must not flood the log on every poll of a call.
      if (!reported)
        logger.warn('answered_by_read_failed', {
          sessionId: watch.route.sessionId,
          ...errorFields(error),
        });
      reported = true;
    }
    if (!stopped && Date.now() < deadline) {
      // A late verdict only cuts a machine off, so after the hold it need not be heard as quickly.
      const delay = Date.now() < fastUntil ? intervalMs : (watch.slowIntervalMs ?? 1_000);
      timer = setTimeout(() => void poll(), delay);
      timer.unref?.();
    }
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** A v2 engine's session input carries the hold; a v1 engine has no such field and is left as is. */
export function holdOpeningForAnsweringMachine(
  rows: { id: string; config?: Record<string, unknown> }[],
  engine: { manifest: { id: string } },
  amd: { timeoutMs: number },
): void {
  const row = rows.find((item) => item.id === engine.manifest.id);
  const session = row?.config?.session;
  if (row && typeof session === 'object' && session !== null)
    row.config = { ...row.config, session: { ...session, amd } };
}
