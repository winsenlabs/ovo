import type { RouteLines } from './ids.ts';
import type { Add } from './issues.ts';
import type { RoutingPointDraft } from './point.ts';
import type { RoutingPath } from './tree.ts';
import {
  HOLD_TERMINAL_STEPS,
  transferHolds,
  type HoldPolicy,
  type RoutingTransferPolicy,
} from './transfer.ts';

/** Every `RouteLines` of a transfer policy with its path (labels, announcements, hold and timeout lines). */
export function transferLines(
  policy: RoutingTransferPolicy | undefined,
): { path: RoutingPath; lines: RouteLines }[] {
  if (!policy) return [];
  const found: { path: RoutingPath; lines: RouteLines }[] = [];
  if (policy.announcement)
    found.push({ path: ['transfer', 'announcement'], lines: policy.announcement });
  if (policy.queueAnnouncement)
    found.push({ path: ['transfer', 'queueAnnouncement'], lines: policy.queueAnnouncement });
  policy.targets.forEach((target, t) => {
    if (target.label)
      found.push({ path: ['transfer', 'targets', t, 'label'], lines: target.label });
    if (target.announcement)
      found.push({ path: ['transfer', 'targets', t, 'announcement'], lines: target.announcement });
  });
  for (const { path, hold } of transferHolds(policy)) {
    hold.steps.forEach((step, s) => {
      if (step.kind === 'line')
        found.push({ path: [...path, 'steps', s, 'line'], lines: step.line });
    });
    hold.onTimeout.forEach((step, s) => {
      if (step.kind === 'callback' || step.kind === 'end')
        found.push({ path: [...path, 'onTimeout', s, 'line'], lines: step.line });
    });
  }
  return found;
}

/** Structural checks of `draft.transfer` (R2), reported through `routingDraftIssues`. */
export function transferDraftIssues(draft: RoutingPointDraft, add: Add): void {
  const policy = draft.transfer;
  if (!policy) return;
  const keys = new Set<string>();
  const nodes = new Set(draft.nodes.map((node) => node.id));
  policy.targets.forEach((target, t) => {
    if (keys.has(target.key))
      add(
        'routing_transfer_key_duplicate',
        ['transfer', 'targets', t, 'key'],
        `Transfer target ${target.key} is defined twice`,
      );
    keys.add(target.key);
    if (target.destination.kind === 'node' && !nodes.has(target.destination.node))
      add(
        'routing_transfer_node_unknown',
        ['transfer', 'targets', t, 'destination', 'node'],
        `No node ${target.destination.node}`,
      );
  });
  for (const { path, hold, key } of transferHolds(policy)) holdIssues(path, hold, keys, add, key);
}

function holdIssues(
  path: RoutingPath,
  hold: HoldPolicy,
  keys: ReadonlySet<string>,
  add: Add,
  key?: string,
): void {
  if (hold.loopFrom >= hold.steps.length)
    add(
      'routing_transfer_hold_loop_invalid',
      [...path, 'loopFrom'],
      `loopFrom ${hold.loopFrom} names no step`,
    );
  const last = hold.onTimeout.at(-1);
  if (!last || !HOLD_TERMINAL_STEPS.includes(last.kind))
    add(
      'routing_transfer_timeout_not_terminal',
      [...path, 'onTimeout'],
      'The timeout chain ends in default, callback or end',
    );
  hold.onTimeout.forEach((step, s) => {
    const at = [...path, 'onTimeout', s];
    if (step.kind === 'target' && (!keys.has(step.key) || step.key === key))
      add(
        'routing_transfer_timeout_target_unknown',
        [...at, 'key'],
        step.key === key ? `A hold cannot time out into its own target` : `No target ${step.key}`,
      );
    // The router's handoff also holds with the point-level policy, and it has no agent to return to.
    if (step.kind === 'return' && key === undefined)
      add(
        'routing_transfer_return_unused',
        at,
        "The router's own handoff skips return; it applies to agent transfers only",
        'warning',
      );
    if (step.kind === 'human')
      add(
        'routing_transfer_human_unavailable',
        at,
        'Human queues arrive in a later release; this step is skipped',
        'warning',
      );
  });
}
