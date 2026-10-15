import type {
  HoldPolicy,
  PinnedAgentRef,
  RouteAgentRef,
  RoutingPath,
  RoutingTransferPolicy,
} from '@winsendotai/ovo-contracts';
import type { Add, RoutingCheckInput } from './routing-publish-checks.ts';
import { livePool, type RoutingResolution } from './routing-publish-resolve.ts';

/** Languages with built-in transfer announcement, queue, hold and end lines (design 4.1). */
const BUILT_IN_LINE_LANGUAGES = new Set(['en', 'hi']);

/** Every hold sequence a catalogue configures, with its draft path: the point's, then each target's. */
function holds(transfer: RoutingTransferPolicy): { path: RoutingPath; hold: HoldPolicy }[] {
  const found: { path: RoutingPath; hold: HoldPolicy }[] = [];
  if (transfer.hold) found.push({ path: ['transfer', 'hold'], hold: transfer.hold });
  transfer.targets.forEach((target, index) => {
    if (target.hold)
      found.push({ path: ['transfer', 'targets', index, 'hold'], hold: target.hold });
  });
  return found;
}

/** Transfer pools must exist and be live; a deleted one blocks a new release (R1 audit 5). */
function poolIssues(transfer: RoutingTransferPolicy, resolution: RoutingResolution, add: Add) {
  transfer.targets.forEach(({ destination }, index) => {
    if (destination.kind !== 'pool') return;
    const path = ['transfer', 'targets', index, 'destination', 'poolId'];
    const pool = resolution.pools.get(destination.poolId);
    if (pool === 'deleted')
      add('routing_transfer_pool_deleted', path, `Pool ${destination.poolId} was deleted`);
    else if (!pool)
      add('routing_transfer_pool_missing', path, `Pool ${destination.poolId} was not found`);
  });
}

/** A new release cannot pin a clip that is gone or deleted; releases that pinned it keep it. */
function audioIssues(transfer: RoutingTransferPolicy, resolution: RoutingResolution, add: Add) {
  for (const { path, hold } of holds(transfer))
    hold.steps.forEach((step, index) => {
      if (step.kind !== 'clip') return;
      const at = [...path, 'steps', index, 'assetId'];
      const clip = resolution.audio.get(step.assetId);
      if (!clip) add('routing_transfer_audio_missing', at, `Clip ${step.assetId} was not found`);
      else if (clip.deletedAt)
        add('routing_transfer_audio_deleted', at, `Clip ${step.assetId} was deleted`);
    });
}

/**
 * Outside en/hi the built-in lines do not exist, so the lines a transfer may need must be
 * authored: an announcement for a target without one, the queue line when a hold waits for
 * capacity, a point hold (the default hold speaks built-in lines) and an `end` step closing every
 * timeout chain (an exhausted chain ends on the built-in end line).
 */
function lineIssues(input: RoutingCheckInput, transfer: RoutingTransferPolicy, add: Add) {
  const language = input.draft.language.default;
  if (BUILT_IN_LINE_LANGUAGES.has(language)) return;
  const missing = (path: RoutingPath, what: string, fix = 'author one') =>
    add(
      'routing_transfer_line_builtin_missing',
      path,
      `No built-in ${what} in ${language}; ${fix}`,
    );
  if (!transfer.announcement && transfer.targets.some((target) => !target.announcement))
    missing(['transfer', 'announcement'], 'transfer announcement');
  const all = holds(transfer);
  if (!transfer.queueAnnouncement && all.some(({ hold }) => hold.waitForCapacity))
    missing(['transfer', 'queueAnnouncement'], 'queue announcement');
  if (!transfer.hold) missing(['transfer', 'hold'], 'hold line', 'configure a point hold');
  for (const { path, hold } of all)
    if (hold.onTimeout.at(-1)?.kind !== 'end')
      missing([...path, 'onTimeout'], 'final end line', 'end the chain with an end step');
}

/** `from` may only name pools, members and agents this point can reach. */
function sourceIssues(transfer: RoutingTransferPolicy, resolution: RoutingResolution, add: Add) {
  const agents = new Set(
    resolution.refs.filter((found) => found.role !== 'router').map((found) => found.ref.agentId),
  );
  transfer.targets.forEach((target, t) =>
    target.from?.forEach((source, s) => {
      const pool =
        source.kind === 'agent' ? undefined : livePool(resolution.pools.get(source.poolId));
      const known =
        source.kind === 'agent'
          ? agents.has(source.agentId)
          : source.kind === 'pool'
            ? pool !== undefined
            : pool?.definition.members.some((member) => member.id === source.memberId) === true;
      if (!known)
        add(
          'routing_transfer_source_unknown',
          ['transfer', 'targets', t, 'from', s],
          `Transfer ${target.key} names a ${source.kind} this point cannot reach`,
          'warning',
        );
    }),
  );
}

/**
 * The transfer catalogue's resolution checks (design 4.6). Transfer agents missing a release are
 * reported with the other references (`routing_transfer_agent_missing`).
 */
export function transferIssues(input: RoutingCheckInput, add: Add): void {
  const transfer = input.draft.transfer;
  if (!transfer) return;
  if (!input.transferEnabled)
    add(
      'routing_transfer_disabled',
      ['transfer'],
      'Transfers stay off until OVO_ROUTING_TRANSFER_ENABLED is true; the release keeps the catalogue',
      'warning',
    );
  poolIssues(transfer, input.resolution, add);
  audioIssues(transfer, input.resolution, add);
  lineIssues(input, transfer, add);
  sourceIssues(transfer, input.resolution, add);
  const offered = input.resolution.refs.some(({ role, release }) => {
    const agents = role === 'router' ? undefined : release?.config.handoff?.agents;
    return agents?.llmTool || Object.keys(agents?.nodes ?? {}).length > 0;
  });
  if (transfer.targets.length && !offered)
    add(
      'routing_transfer_unreachable',
      ['transfer', 'targets'],
      'No release this point reaches offers transfer_to_agent or transfers from a flow node',
      'warning',
    );
}

/**
 * The catalogue as a release freezes it: every agent destination pinned to the release it
 * resolved to and every clip pinned to the sha256 of the bytes it names.
 */
export function pinnedTransfer(
  transfer: RoutingTransferPolicy,
  resolution: RoutingResolution,
  pin: (ref: RouteAgentRef) => PinnedAgentRef,
): RoutingTransferPolicy {
  const pinned = structuredClone(transfer);
  pinned.targets.forEach((target, index) => {
    const original = transfer.targets[index]!.destination;
    if (target.destination.kind === 'agent' && original.kind === 'agent')
      target.destination.agent = pin(original.agent);
  });
  for (const { hold } of holds(pinned))
    for (const step of hold.steps)
      if (step.kind === 'clip') step.sha256 = resolution.audio.get(step.assetId)!.sha256;
  return pinned;
}
