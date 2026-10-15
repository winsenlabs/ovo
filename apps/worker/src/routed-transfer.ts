import { routingVoiceLines, type RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { createLogger } from '@winsendotai/ovo-plugin-kit';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { CallMemory } from './call-memory.ts';
import type { CallScope } from './call-scope.ts';
import type { SegmentInput } from './call-segment.ts';
import { HoldPlayer } from './hold-player.ts';
import { createHoldVoice, type HoldVoice } from './hold-voice.ts';
import { createHumanRuntime, snapshotQueues } from './human-wiring.ts';
import {
  endRoutedCall,
  releaseClaims,
  routingHost,
  type RoutedJob,
  type RoutingRuntimeOptions,
} from './routed-call-support.ts';
import {
  routedCallSeconds,
  routedSegmentComposer,
  type LiveSessionDeps,
} from './routed-segments.ts';
import { routerSegmentShape } from './router-graph.ts';
import { routeEventSink } from './routing-events.ts';
import { SegmentMediaLease } from './segment-media.ts';
import type { ProviderUsage } from './cost-policy-types.ts';
import { SegmentStats, segmentTelemetry } from './segment-telemetry.ts';
import { openReleaseSpeech } from './speech-cache-release-tts.ts';
import type { AttemptTarget } from './transfer-attempt.ts';
import { TransferController } from './transfer-controller.ts';
import { agentTransferService, createAgentTransferPort } from './transfer-port.ts';
import { granted, resolveTransfer } from './transfer-targets.ts';

const log = createLogger({ service: 'worker' });

export interface TransferControl {
  controller: TransferController;
  compose: ReturnType<typeof routedSegmentComposer>;
  /** What every segment of the call gets (segment 0 included): see `decorate` below. */
  decorate(input: SegmentInput, index: number, target?: AttemptTarget): SegmentInput;
}

/**
 * A routed call with in-call transfers on (`OVO_ROUTING_TRANSFER_ENABLED`, transfer design 7.1):
 * one `TransferController` and one `CallMemory` per call, and every segment composed with
 *
 * - its audits stamped `segment: <index>`, its usage tagged with its index in the ledger and
 *   counted for its `segment.ended`, and its outcome events through the call's memory (captured
 *   values, disclosures heard, the route) and mirrored into the Events tab;
 * - its final caller words and heard lines in the call's memory, for handovers;
 * - the point's fixed lines for its release approved for the speech cache;
 * - an agent: the `ovo.agent-transfer` host service, bound to its index, release and member;
 * - a router re-entering the tree: the router behaviour with its `entry`.
 */
export function transferControl(
  deps: LiveSessionDeps,
  options: RoutingRuntimeOptions,
  scope: CallScope,
  routerRelease: ReleaseRecord,
  routing: RoutedJob,
  snapshot: RoutingReleaseSnapshot,
  variables: Readonly<Record<string, unknown>>,
): TransferControl {
  const { job, telemetry } = scope;
  const policy = snapshot.transfer;
  const memory = new CallMemory();
  const call = { jobId: job.id, sessionId: scope.route.sessionId };
  const defaultRelease = snapshot.defaultTarget.release.releaseId;
  const sink = routeEventSink(scope.events, { releaseId: defaultRelease, telemetry, call });
  const record = (type: string, payload: Record<string, unknown>) =>
    void sink.append(type, payload);
  const transferLog = (event: string, fields: Record<string, unknown>) =>
    log.info(event, { ...call, ...fields });
  // A transfer's claim that finds storage down proceeds unclaimed (fail-open, design 8.1).
  const host = routingHost(deps, options, scope, routerRelease, routing, variables, (type, p) =>
    telemetry.audit(type === 'route.claims.unavailable' ? 'transfer.claims.unavailable' : type, p),
  );
  const claims = {
    claim: (tiers: Parameters<typeof host.claim>[0]) =>
      host.claim(tiers, new AbortController().signal),
    release: () => releaseClaims(options.routing?.claims, job.id, telemetry),
  };
  const format = scope.carrierMedia!.format;
  let voice: HoldVoice | undefined;
  const houseVoice = () =>
    (voice ??= createHoldVoice({
      ...{ release: routerRelease, format, sessionId: scope.route.sessionId },
      open: (usage) =>
        openReleaseSpeech(routerRelease, usage, {
          catalog: deps.graph.distribution.catalog,
          parent: deps.graph.parent,
          secrets: deps.secrets,
          defaults: deps.graph.distribution.defaults,
        }),
      usage: (event) => deps.costUsageForJob?.(job.id)?.(event),
      ...(deps.speechCache ? { tiers: deps.speechCache.cache } : {}),
    }));
  scope.cleanup.defer(() => voice?.close());
  const targets = { snapshot, memory, claims, now: () => Date.now() };
  /** The call's usage sink for segment `index`: its ledger rows carry the index. */
  const segmentUsage = (index: number) => (event: ProviderUsage) => {
    const usage = options.usageForSegment?.(job.id, index);
    if (usage) usage(event);
    else deps.costUsageForJob?.(job.id)?.(event);
  };
  const controller: TransferController = new TransferController({
    ...{ media: scope.media, format, allowed: new Set(snapshot.releaseIds), memory },
    fallback: { agentId: snapshot.defaultTarget.agentId, releaseId: defaultRelease },
    router: { agentId: routerRelease.agentId, releaseId: routerRelease.id },
    ...(policy ? { policy } : {}),
    ...(options.humanQueue
      ? {
          human: createHumanRuntime({
            ...{ deps, options: options.humanQueue, scope, routerRelease, routing, snapshot },
            ...{ memory, targets, record, log: transferLog, releaseClaim: claims.release },
            controller: () => controller,
            usageFor: (index) => segmentUsage(index),
          }),
        }
      : {}),
    compose: (target, index, lease) => compose(target, index, lease),
    record,
    audit: (type, payload) => telemetry.audit(type, payload),
    log: transferLog,
    claims,
    async resolveTarget(key, from) {
      const target = policy?.targets.find((item) => item.key === key);
      if (!policy || !target) return { refusal: 'unknown_target' };
      if (!granted(target, from)) return { refusal: 'not_granted' };
      return resolveTransfer({ ...targets, policy }, target, from, { source: 'fallback' });
    },
    holdPlayer: (holdPolicy, tags) =>
      new HoldPlayer({
        media: new SegmentMediaLease(scope.media, { format, live: true }),
        ...{ format, policy: holdPolicy, tags },
        language: {
          ...(memory.route?.language ? { call: memory.route.language } : {}),
          default: snapshot.language.default,
        },
        ...(options.holdClips ? { clips: options.holdClips } : {}),
        voice: houseVoice(),
        audit: (type, payload) => telemetry.audit(type, payload),
      }),
    endCall: (reason) => endRoutedCall(deps, scope, reason),
    callEndsAt: scope.openedAt + routedCallSeconds(routerRelease) * 1000,
    defaultLanguage: snapshot.language.default,
    timezone: routerRelease.config.timezone,
    ...(options.prepareTimeoutMs !== undefined
      ? { prepareTimeoutMs: options.prepareTimeoutMs }
      : {}),
  });
  const lines = routingVoiceLines(snapshot);
  const decorate = (input: SegmentInput, index: number, target?: AttemptTarget): SegmentInput => {
    const { release } = input;
    const stats = new SegmentStats(index, release.config.language);
    const role =
      target?.role ?? (index === 0 && release.id === routerRelease.id ? 'router' : 'agent');
    const events = memory.sink(
      routeEventSink(scope.events, {
        releaseId: role === 'router' ? defaultRelease : release.id,
        telemetry: segmentTelemetry(telemetry, index),
        index,
        call,
      }),
    );
    const own =
      role === 'router' && target?.entry
        ? routerSegmentShape({
            ...{ behavior: options.routerBehavior(), routerRelease, snapshot, entry: target.entry },
            ...{ host, sessionId: scope.route.sessionId, handoff: controller },
          })
        : {};
    const port =
      role === 'agent'
        ? createAgentTransferPort({
            controller,
            self: {
              ...{ index, agentId: release.agentId, releaseId: release.id },
              ...(target?.poolId ? { poolId: target.poolId } : {}),
              ...(target?.memberId ? { memberId: target.memberId } : {}),
            },
            release,
            ...(policy ? { policy } : {}),
            targets,
            humanQueue: (key) => snapshotQueues(snapshot).get(key),
            record,
            log: transferLog,
          })
        : undefined;
    return {
      ...input,
      events,
      telemetry: segmentTelemetry(telemetry, index),
      usage: (event) => {
        stats.meter(event);
        segmentUsage(index)(event);
      },
      stats,
      shape: {
        ...input.shape,
        ...own,
        services: [
          ...(own.services ?? input.shape?.services ?? []),
          ...(port ? [agentTransferService(port)] : []),
        ],
        transcripts: (event) => memory.transcript(event),
        approvedLines: lines.get(release.id) ?? [],
      },
    };
  };
  const compose = routedSegmentComposer(deps, scope, routerRelease, {
    mayEndCall: (lease) => controller.mayEndCall(lease),
    decorate: (input, { index, target }) =>
      decorate(input, index, 'role' in target ? target : undefined),
  });
  return { controller, compose, decorate };
}
