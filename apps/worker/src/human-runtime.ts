import type {
  AudioFormat,
  HoldPolicy,
  RoutingTransferPolicy,
  SecretResolver,
  TransferTarget,
  UsageSink,
} from '@winsendotai/ovo-contracts';
import { isOpen } from '@winsendotai/ovo-plugin-router';
import type { WebhookDeps } from '@winsendotai/ovo-session-host';
import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import { buildTicketContext, maskNumber, type ContextMeta } from './human-context.ts';
import { SUMMARY_TIMEOUT_MS } from './human-summary.ts';
import type {
  HumanRefusal,
  MediaRoomProvider,
  QueueSnapshot,
  Ticket,
  TicketContext,
  HumanQueuePort,
} from './human-contract.ts';
import type { HumanShared } from './human-breaker.ts';
import type { HumanSource } from './human-events.ts';
import type { HoldClock } from './hold-player.ts';
import { HumanExternalAttempt } from './human-external.ts';
import { HumanManagedAttempt } from './human-managed.ts';
import type { HumanAttempt, HumanAttemptInit } from './human-attempt.ts';
import type { OpenStt, TranscriptSink } from './human-transcriber.ts';
import type { SegmentMediaLease } from './segment-media.ts';
import type { HoldSource } from './transfer-types.ts';

/** The built-in wait of a queue that configures none (human queue design 4.4, 16.6). */
export const DEFAULT_QUEUE_HOLD_POLICY: HoldPolicy = Object.freeze<HoldPolicy>({
  steps: [
    { kind: 'silence', seconds: 2 },
    {
      kind: 'line',
      line: {
        en: 'Thank you for holding. A colleague will be with you shortly.',
        hi: 'होल्ड करने के लिए धन्यवाद। एक सहयोगी जल्द ही आपसे बात करेंगे।',
      },
    },
  ],
  loopFrom: 0,
  maxSeconds: 180,
  waitForCapacity: false,
  onTimeout: [{ kind: 'return' }, { kind: 'default' }, { kind: 'end', line: { en: 'Goodbye.' } }],
});

export * from './human-runtime-deps.ts';
import type { HumanRuntimeDeps } from './human-runtime-deps.ts';

/** Why a queue could not be asked for, or the queue it resolved to. */
export type Prechecked = { ok: true; queue: QueueSnapshot } | { ok: false; reason: HumanRefusal };

/**
 * What a routed call's human queues share (human queue design 7.1): the release's queue snapshots
 * by key, the precheck `begin` runs before anything is announced, the hold a queue waits with, and
 * the factories of the two kinds of attempt. One per call, created only when the master flag is
 * on and the release binds queues; without it every `human` step is skipped as in R2.
 */
export class HumanRuntime {
  private opened = 0;

  constructor(readonly deps: HumanRuntimeDeps) {}

  queue(key: string): QueueSnapshot | undefined {
    return this.deps.queues.get(key);
  }

  /** The next ticket number of this call: the idempotency key is `hq:<workspace>:<job>:<n>`. */
  nextTicket(): number {
    return ++this.opened;
  }

  /**
   * The gates a handoff must pass before the caller is told anything (design 7.2): the queue is
   * bound and open, its third party or room is reachable, and someone can take the call.
   */
  async precheck(key: string): Promise<Prechecked> {
    const { deps } = this;
    const queue = deps.queues.get(key);
    if (!queue) return { ok: false, reason: 'queue_unknown' };
    const def = queue.definition;
    if (def.hours && !this.open(def.hours)) return { ok: false, reason: 'queue_closed' };
    try {
      if (def.kind === 'external') {
        // Without an origin for the callback links a third party could not answer later.
        if (!deps.webhookEnabled || !deps.callbackBaseUrl || deps.shared.breaker(queue.id).open)
          return { ok: false, reason: 'queue_unavailable' };
      } else {
        if (
          !deps.rooms ||
          deps.shared.breaker(queue.id).open ||
          !(await deps.shared.roomHealthy(deps.rooms))
        )
          return { ok: false, reason: 'queue_unavailable' };
        if (def.requireOnline) {
          const language = deps.memory.route?.language;
          const people = await deps.service.operators.availability(
            { queueId: queue.id, teamIds: def.teamIds, language: def.language },
            language,
          );
          if (people.withRoom < 1) return { ok: false, reason: 'no_operators' };
        }
      }
      const stats = await deps.service.queues?.stats(queue.id);
      if (stats && stats.waiting + stats.offered >= def.limits.maxWaiting)
        return { ok: false, reason: 'queue_full' };
    } catch {
      // swallow-ok: storage down fails closed (no ticket means nobody can answer); the chain moves on.
      return { ok: false, reason: 'queue_unavailable' };
    }
    return { ok: true, queue };
  }

  private open(hours: NonNullable<QueueSnapshot['definition']['hours']>): boolean {
    try {
      return isOpen(hours, this.deps.clock.now());
    } catch {
      // swallow-ok: an unknown zone cannot pass publish; if one arrives, the queue reads closed.
      this.deps.audit('human.hours.invalid', {});
      return false;
    }
  }

  /** The wait of a queue: its own hold, the catalogue target's, the point's, else the built-in. */
  hold(
    queue: QueueSnapshot,
    target?: Pick<TransferTarget, 'hold'>,
  ): { policy: HoldPolicy; source: HoldSource } {
    if (queue.definition.hold) return { policy: queue.definition.hold, source: 'queue' };
    if (target?.hold) return { policy: target.hold, source: 'target' };
    if (this.deps.policy?.hold) return { policy: this.deps.policy.hold, source: 'point' };
    return { policy: DEFAULT_QUEUE_HOLD_POLICY, source: 'queue' };
  }

  /** The ticket's context from the call so far, honouring the queue's policy (design 7.3). */
  async context(input: {
    queue: QueueSnapshot;
    from: SegmentHistoryEntry;
    target?: TransferTarget;
    meta?: ContextMeta;
  }): Promise<TicketContext> {
    const { deps } = this;
    const def = input.queue.definition;
    const language = deps.memory.route?.language ?? 'en';
    const targets = deps.policy?.targets ?? [];
    const returns =
      def.kind === 'managed'
        ? def.returnTargets.flatMap((key) => {
            const found = targets.find((item) => item.key === key);
            return found
              ? [{ key, label: found.label?.[language] ?? key.replace(/[_-]+/g, ' ') }]
              : [];
          })
        : [];
    const meta = await this.withGeneratedSummary(def.context, input.meta);
    const declared = def.context.variables === 'declared';
    const values = declared
      ? await deps.declaredValues(input.from).catch(() => ({}))
      : deps.memory.captured;
    return buildTicketContext({
      policy: def.context,
      callId: deps.call.callId,
      numbers: deps.call.numbers,
      memory: deps.memory,
      ...(meta ? { meta } : {}),
      askedFor: input.target
        ? (input.target.label?.[language] ?? input.target.key.replace(/[_-]+/g, ' '))
        : def.name,
      from: input.from,
      values,
      returnTargets: returns,
    });
  }

  /** An attempt for `queue` on the given segment index and held lease (created at `begin`). */
  attempt(init: Omit<HumanAttemptInit, 'runtime'>): HumanAttempt {
    const full = { ...init, runtime: this };
    return init.queue.definition.kind === 'external'
      ? new HumanExternalAttempt(full)
      : new HumanManagedAttempt(full);
  }

  /**
   * The generated note (P2) replaces the agent's summary when it arrives within three seconds,
   * alongside the requester's announcement; else the agent's summary stands. Never throws.
   */
  private async withGeneratedSummary(
    policy: QueueSnapshot['definition']['context'],
    meta: ContextMeta | undefined,
  ): Promise<ContextMeta | undefined> {
    const { deps } = this;
    if (policy.summarize !== 'generate' || !policy.summary || !deps.summarize) return meta;
    const stop = new AbortController();
    const timer = deps.clock
      .sleep(SUMMARY_TIMEOUT_MS, stop.signal)
      .then(() => (stop.signal.aborted ? undefined : ('timeout' as const)));
    const work = deps
      .summarize({
        lines: deps.memory.recent(),
        ...(meta?.summary ? { hint: meta.summary } : {}),
        signal: stop.signal,
      })
      .catch(() => undefined);
    const generated = await Promise.race([work, timer]);
    stop.abort();
    if (generated === 'timeout' || !generated) {
      deps.audit('human.summary.fallback', { reason: generated ? 'timeout' : 'unavailable' });
      return meta;
    }
    return { ...meta, summary: generated };
  }

  masked(): string | undefined {
    return maskNumber(this.deps.call.numbers.from);
  }
}

export type { HumanSource, Ticket };
