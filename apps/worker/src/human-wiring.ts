import {
  Cap,
  filterDeclaredVariables,
  type Inference,
  type RoutingReleaseSnapshot,
} from '@winsendotai/ovo-contracts';
import type { CallMemory, SegmentHistoryEntry } from './call-memory.ts';
import type { CallScope } from './call-scope.ts';
import { HumanShared } from './human-breaker.ts';
import type { HumanQueuePort, MediaRoomProvider, QueueSnapshot } from './human-contract.ts';
import { createReturnToAgent } from './human-return.ts';
import { DEFAULT_QUEUE_HOLD_POLICY, HumanRuntime } from './human-runtime.ts';
import type { HoldPlayer } from './hold-player.ts';
import { realHoldClock } from './hold-player.ts';
import type { RoutedJob } from './routed-call-support.ts';
import type { LiveSessionDeps } from './routed-segments.ts';
import { segmentTelemetry } from './segment-telemetry.ts';
import { generateSummary } from './human-summary.ts';
import { composeReleaseProvider } from './speech-cache-release-tts.ts';
import { openReleaseStt } from './session-stt-preconnect.ts';
import type { CarrierHandoff, TransferTargets } from './worker-carrier-handoff.ts';
import type { TransferController } from './transfer-controller.ts';
import { resolveTransfer, type TargetContext } from './transfer-targets.ts';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import type { ProviderUsage } from './cost-policy-types.ts';

/** What a routed call is given to run human queues (set by the worker bootstrap, off by default). */
export interface HumanQueueOptions {
  /** `OVO_HUMAN_QUEUE_ENABLED`: the master switch. */
  enabled: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`. */
  webhookEnabled: boolean;
  /** `OVO_HUMAN_QUEUE_CALLBACK_BASE_URL`, else the public media base. */
  callbackBaseUrl: string;
  /** `OVO_HUMAN_QUEUE_POLL_MS`. */
  pollMs: number;
  /** `OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS`. */
  contextRetentionHours: number;
  service?: HumanQueuePort;
  rooms?: MediaRoomProvider;
  shared: HumanShared;
  /** Moves the live carrier leg before the session ends. */
  carrierHandoff?: CarrierHandoff;
  /** Where a session that ends `transferred` goes, by session id. */
  transferTargets?: TransferTargets;
  /** Test injection: DNS lookup and fetch for the webhook. */
  network?: ConstructorParameters<typeof HumanRuntime>[0]['network'];
}

/** The release's queues by the binding key a `human` step or target names. */
export function snapshotQueues(snapshot: RoutingReleaseSnapshot): Map<string, QueueSnapshot> {
  const queues = (snapshot as { queues?: Record<string, QueueSnapshot> }).queues ?? {};
  return new Map(Object.values(queues).map((queue) => [queue.key, queue]));
}

/**
 * A routed call's human queues (human queue design 7.1): composed only when the master flag is on,
 * the release binds queues and the worker has a ticket store; otherwise `human` steps stay skipped
 * as in R2. The runtime reaches the controller lazily (it is built with this runtime as a dep).
 */
export function createHumanRuntime(input: {
  deps: LiveSessionDeps;
  options: HumanQueueOptions;
  scope: CallScope;
  routerRelease: ReleaseRecord;
  routing: RoutedJob;
  snapshot: RoutingReleaseSnapshot;
  memory: CallMemory;
  controller: () => TransferController;
  targets: Omit<TargetContext, 'policy'>;
  usageFor(index: number): (event: ProviderUsage) => void;
  record(type: string, payload: Record<string, unknown>): void;
  log(event: string, fields: Record<string, unknown>): void;
  releaseClaim(): Promise<void>;
}): HumanRuntime | undefined {
  const { deps, options, scope, snapshot, memory, routerRelease } = input;
  const queues = snapshotQueues(snapshot);
  if (!options.enabled || !options.service || !queues.size) return undefined;
  const { job, telemetry } = scope;
  const policy = snapshot.transfer;
  const transferTargets = options.transferTargets;
  const payload = job.payload;
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const numbers = {
    ...(text(payload.from) ? { from: text(payload.from)! } : {}),
    ...(text(payload.to) ? { to: text(payload.to)! } : {}),
  };
  const holdPlayer = (tags: Record<string, unknown>): HoldPlayer =>
    input.controller().deps.holdPlayer(DEFAULT_QUEUE_HOLD_POLICY, tags);
  const returnToAgent = createReturnToAgent({
    controller: {
      beginWith: (...args) => input.controller().beginWith(...args),
      commit: (id) => input.controller().commit(id),
      abandon: (id) => input.controller().abandon(id),
      get ended() {
        return input.controller().ended;
      },
    },
    ...(policy ? { policy } : {}),
    // The queue's `returnTargets` already granted the key: no source check (design 7.5).
    resolve: (target, from) =>
      resolveTransfer({ ...input.targets, policy: policy! }, target, from, { source: 'fallback' }),
    holdPlayer,
    releaseClaim: input.releaseClaim,
  });
  return new HumanRuntime({
    queues,
    service: options.service,
    ...(options.rooms ? { rooms: options.rooms } : {}),
    shared: options.shared,
    webhookEnabled: options.webhookEnabled,
    clock: realHoldClock,
    ended: () => input.controller().endedSignal,
    call: {
      workspaceId: job.workspaceId,
      jobId: job.id,
      sessionId: scope.route.sessionId,
      callId: scope.callId,
      routingReleaseId: input.routing.routingReleaseId,
      routerAgentId: routerRelease.agentId,
      direction: payload.kind === 'inbound_call' ? 'inbound' : 'outbound',
      startedAt: scope.openedAt,
      numbers,
    },
    format: scope.carrierMedia!.format,
    ...(policy ? { policy } : {}),
    memory,
    secrets: deps.secrets.forAgent(routerRelease.agentId),
    callbackBaseUrl: options.callbackBaseUrl,
    pollMs: options.pollMs,
    contextRetentionHours: options.contextRetentionHours,
    ...(options.network ? { network: options.network } : {}),
    record: input.record,
    audit: (type, fields) => telemetry.audit(type, fields),
    log: input.log,
    ...(options.carrierHandoff
      ? {
          carrierHandoff: (target, ticketId) =>
            options.carrierHandoff!(job, scope.route, target, ticketId),
        }
      : {}),
    // The leg left OVO: the session ends `transferred` and nothing is handed on or hung up again.
    endHandedOff: async () => {
      transferTargets?.set(scope.route.sessionId, { handedOff: true });
      try {
        await deps.beforeEngineMediaClose?.(job, scope.route, 'transferred');
      } finally {
        await scope.media.close('transferred');
      }
    },
    endCall: async (lease, reason) => {
      if (input.controller().mayEndCall(lease))
        await deps.beforeEngineMediaClose?.(job, scope.route, reason);
      await lease.close(reason);
    },
    declaredValues: async (from: SegmentHistoryEntry) => {
      const release = await deps.store.getRelease(job.workspaceId, from.releaseId);
      return release ? filterDeclaredVariables(release.config, memory.captured) : {};
    },
    returnToAgent,
    openStt: (usage) =>
      openReleaseStt(routerRelease, usage, {
        catalog: [...deps.graph.distribution.catalog, ...deps.extensions.plugins],
        parent: deps.graph.parent,
        secrets: deps.secrets,
      })(),
    transcript: (event, segment) => {
      segmentTelemetry(telemetry, segment).engineEvent(event);
      memory.transcript(event);
    },
    summarize: summarizer(input),
    sttLanguage: routerRelease.config.language,
    usageFor: input.usageFor,
    attachedEntry: () => input.controller().attached,
  });
}

/** The operations service's ticket store, when it has one (R3; absent in a slim composition). */
export function humanServiceOf(operations: unknown): HumanQueuePort | undefined {
  return (operations as { humanQueues?: HumanQueuePort } | undefined)?.humanQueues;
}

/** The room provider composed into the process (absent unless the room feature is on). */
export function roomsOf(
  graph: LiveSessionDeps['graph'] | undefined,
): MediaRoomProvider | undefined {
  const key = (Cap as Record<string, string | undefined>).mediaRoom;
  if (!key) return undefined;
  try {
    return graph?.parent.ctx.get(key as never) as MediaRoomProvider | undefined;
  } catch {
    // swallow-ok: a slim composition has no room provider; managed queues then refuse.
    return undefined;
  }
}

/**
 * What a routed call is given to run human queues, or nothing: they need the master switch and
 * the operations ticket store; rooms and the carrier handoff are what their kinds add.
 */
export function humanQueueOptions(input: {
  env: Pick<HumanQueueOptions, 'enabled' | 'webhookEnabled' | 'callbackBaseUrl' | 'pollMs'> &
    Pick<HumanQueueOptions, 'contextRetentionHours'> &
    Partial<Pick<HumanQueueOptions, 'network'>>;
  service: HumanQueuePort | undefined;
  rooms: MediaRoomProvider | undefined;
  transferTargets: TransferTargets;
  carrierHandoff?: CarrierHandoff;
}): HumanQueueOptions | undefined {
  if (!input.env.enabled || !input.service) return undefined;
  return {
    ...input.env,
    service: input.service,
    shared: new HumanShared(),
    transferTargets: input.transferTargets,
    ...(input.rooms ? { rooms: input.rooms } : {}),
    ...(input.carrierHandoff ? { carrierHandoff: input.carrierHandoff } : {}),
  };
}

/**
 * The router release's own LLM, composed on first use outside any segment (the router's graph is
 * gone by then) and closed with the call. A release with no LLM selection never summarises.
 */
function summarizer(
  input: Parameters<typeof createHumanRuntime>[0],
): NonNullable<ConstructorParameters<typeof HumanRuntime>[0]['summarize']> | undefined {
  const { deps, routerRelease, scope } = input;
  if (!routerRelease.selections?.llm) return undefined;
  let opened: Promise<{ inference: Inference; close(): Promise<void> }> | undefined;
  const open = () =>
    (opened ??= (async () => {
      const composition = await composeReleaseProvider(routerRelease, 'llm', input.usageFor(0), {
        catalog: [...deps.graph.distribution.catalog, ...deps.extensions.plugins],
        parent: deps.graph.parent,
        secrets: deps.secrets,
      });
      const inference = composition.get(Cap.inference) as Inference | undefined;
      if (!inference) {
        await composition.dispose();
        throw new Error('release has no inference');
      }
      return { inference, close: () => composition.dispose() };
    })());
  scope.cleanup.defer(async () => {
    // swallow-ok: a model that never opened has nothing to close.
    await (await opened?.catch(() => undefined))?.close();
  });
  return async ({ lines, hint, signal }) =>
    generateSummary((await open()).inference, { lines, ...(hint ? { hint } : {}), signal });
}
