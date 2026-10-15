import { definePlugin, type PluginDefinition } from '@winsendotai/ovo-runtime';
import {
  Cap,
  TRANSFER_BUILT_IN_LINES,
  TRANSFER_LIMITS,
  type AgentConfig,
  type AgentTransferPort,
  type AgentTransferRefusal,
  type AgentTransferResult,
  type HandoffBeginFailure,
  type RouteLines,
  type RoutingTransferPolicy,
  type TransferTarget,
} from '@winsendotai/ovo-contracts';
import type { SegmentHistoryEntry } from './call-memory.ts';
import { lineFor } from './hold-player.ts';
import { memberCandidate } from './transfer-begin.ts';
import type { TransferController } from './transfer-controller.ts';
import { DEFAULT_HANDOVER } from './transfer-handover.ts';
import { granted, resolveTransfer, type TargetContext } from './transfer-targets.ts';

/** The host service offering one agent segment its transfer port (transfer design 7.1). */
export const AGENT_TRANSFER_SERVICE_ID = '@winsendotai/ovo-host-agent-transfer';

export function agentTransferService(port: AgentTransferPort): PluginDefinition {
  return definePlugin(
    {
      id: AGENT_TRANSFER_SERVICE_ID,
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      requires: [],
      provides: [Cap.agentTransfer],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.agentTransfer, port);
    },
  );
}

/**
 * The port as the agent behaviour reads it: `summary` says whether the point's handover takes the
 * transferring agent's summary, so `transfer_to_agent` asks for one only then (design 7.2).
 */
export type TransferPort = AgentTransferPort & { readonly summary: boolean };

const REFUSALS: Partial<Record<HandoffBeginFailure, AgentTransferRefusal>> = {
  busy: 'busy',
  call_ended: 'call_ended',
  pool_full: 'pool_full',
  segments_exhausted: 'segments_exhausted',
  time_exhausted: 'time_exhausted',
  release_missing: 'release_missing',
  release_not_allowed: 'release_missing',
};

/**
 * One agent segment's `AgentTransferPort` (transfer design 4.3, 7.2): the catalogue targets the
 * point grants it, and `request`, which gates in the design's order (each refusal a
 * `transfer.requested` event the LLM can act on), resolves the target, claims, and begins the
 * transfer on the call's controller without waiting for the composition. `inbound` is what this
 * segment inherited, when a transfer started it.
 */
export function createAgentTransferPort(input: {
  controller: TransferController;
  /** This segment, as the controller will attach it. */
  self: Pick<SegmentHistoryEntry, 'index' | 'agentId' | 'releaseId' | 'poolId' | 'memberId'>;
  release: { config: Pick<AgentConfig, 'language' | 'variables' | 'handoff'> };
  policy?: RoutingTransferPolicy;
  targets: Omit<TargetContext, 'policy'>;
  record(type: string, payload: Record<string, unknown>): void;
  log(event: string, fields: Record<string, unknown>): void;
}): TransferPort {
  const { controller, policy, self } = input;
  const config = input.release.config;
  const language = config.language.split('-')[0]!;
  const entry: SegmentHistoryEntry = { ...self, role: 'agent', startedAt: 0 };
  const exhausted = () =>
    !policy ||
    controller.transfers >=
      Math.min(policy.limits.maxTransfers, TRANSFER_LIMITS.maxTransfersPerCall) ||
    controller.segments >= TRANSFER_LIMITS.segmentsPerCall ||
    (controller.deps.callEndsAt - controller.clock.now()) / 1000 <
      policy.limits.minRemainingSeconds;
  const requested = (
    target: { key: string; kind: string; confirm: string },
    source: string,
    outcome: { refusal: AgentTransferRefusal } | { queued: boolean },
  ) => {
    const accepted = 'queued' in outcome;
    input.record('transfer.requested', {
      ...{ transfer: controller.transfers + (accepted ? 0 : 1), fromSegment: self.index },
      ...{ source, kind: target.kind, key: target.key, confirm: target.confirm },
      ...(accepted
        ? { result: 'accepted', queued: outcome.queued }
        : { result: 'refused', ...outcome }),
    });
    input.log('transfer_requested', {
      ...{ key: target.key, kind: target.kind, fromSegment: self.index },
      ...(accepted ? { result: 'accepted' } : { result: 'refused', refusal: outcome.refusal }),
    });
  };
  const port: TransferPort = {
    summary: (policy?.handover ?? DEFAULT_HANDOVER).summary,
    get inbound() {
      return controller.handover(self.index, config);
    },
    targets() {
      if (exhausted()) return [];
      return policy!.targets
        .filter((target) => granted(target, entry))
        .map((target) => ({
          key: target.key,
          description: target.description,
          ...(target.label ? { label: lineFor(target.label, language, language).text } : {}),
          confirm: target.confirm ?? policy!.confirm,
        }));
    },
    async request(request, signal): Promise<AgentTransferResult> {
      const target = policy?.targets.find((item) => item.key === request.key);
      const kind = target ? kindOf(target) : 'agent';
      const confirm = (target?.confirm ?? policy?.confirm) === 'ask' ? 'asked' : 'never';
      const refuse = (refusal: AgentTransferRefusal): AgentTransferResult => {
        requested({ key: request.key.slice(0, 200), kind, confirm }, request.source, { refusal });
        return { ok: false, reason: refusal };
      };
      if (!policy) return refuse('transfer_disabled');
      if (controller.busy) return refuse('busy');
      if (controller.ended || signal.aborted || controller.attached?.index !== self.index)
        return refuse('call_ended');
      if (!target) return refuse('unknown_target');
      if (!granted(target, entry)) return refuse('not_granted');
      if (
        controller.transfers >=
        Math.min(policy.limits.maxTransfers, TRANSFER_LIMITS.maxTransfersPerCall)
      )
        return refuse('limit_reached');
      if (controller.segments >= TRANSFER_LIMITS.segmentsPerCall)
        return refuse('segments_exhausted');
      const remaining = (controller.deps.callEndsAt - controller.clock.now()) / 1000;
      if (remaining < policy.limits.minRemainingSeconds) return refuse('time_exhausted');
      if (confirm === 'asked' && !request.confirmed) return refuse('not_confirmed');
      const meta = {
        source: request.source,
        ...(request.reason ? { reason: request.reason.slice(0, TRANSFER_LIMITS.reasonChars) } : {}),
        ...(request.summary
          ? { summary: request.summary.slice(0, TRANSFER_LIMITS.summaryChars) }
          : {}),
      };
      const resolved = await resolveTransfer({ ...input.targets, policy }, target, entry, meta);
      if ('refusal' in resolved) return refuse(resolved.refusal);
      const begun = await controller.beginWith(resolved.request, signal, {
        target,
        claimed: resolved.claimed,
      });
      if (!begun.ok) {
        if (resolved.claimed) await reclaim();
        return refuse(REFUSALS[begun.reason] ?? 'transfer_disabled');
      }
      const queued = begun.state === 'queued';
      requested({ key: target.key, kind: resolved.request.kind, confirm }, request.source, {
        queued,
      });
      return {
        ok: true,
        transferId: begun.handoffId,
        announcement: announce(target, queued),
        queued,
      };
    },
    commit(transferId) {
      controller.commit(transferId);
    },
    async cancel(transferId) {
      const run = controller.uncommitted(transferId);
      if (!run) return;
      await controller.abandon(transferId);
      await reclaim();
      if (run.transfer !== undefined)
        input.record('transfer.completed', {
          ...{ transfer: run.transfer, outcome: 'failed', reason: 'cancelled' },
          ...{ holdMs: 0, holdPolicy: run.hold.source, steps: [] },
        });
    },
  };
  /** Best effort: the member this segment was claimed from is claimed again. */
  async function reclaim(): Promise<void> {
    const member = memberCandidate(entry);
    if (member) await input.targets.claims.claim([[member]]);
  }
  /** The target's line, else the point's (its queue line when queued), in this agent's language. */
  function announce(target: TransferTarget, queued: boolean): string {
    const authored: RouteLines | undefined =
      target.announcement ?? (queued ? policy?.queueAnnouncement : policy?.announcement);
    if (authored?.[language]) return authored[language];
    const own = config.handoff?.agents?.line;
    if (own) return own;
    const builtIn = queued ? TRANSFER_BUILT_IN_LINES.queue : TRANSFER_BUILT_IN_LINES.announcement;
    return lineFor(builtIn, language, 'en').text;
  }
  return port;
}

function kindOf(target: TransferTarget): 'agent' | 'queue' | 'node' {
  return target.destination.kind === 'node' ? 'node' : 'agent';
}
