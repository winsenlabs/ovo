import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import type { HumanQueueStatus } from '../types/desk';
import type { QueueRecord } from '../types/queues';

/** Where each bound queue key is named: tree branches, fallback steps, transfer targets and holds. */
export function queueUsage(draft: RoutingPointDraft): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const add = (key: string, where: string) => used.set(key, [...(used.get(key) ?? []), where]);
  for (const node of draft.nodes) {
    for (const branch of node.branches)
      if (branch.target?.kind === 'human') add(branch.target.queueId, `${node.id} > ${branch.key}`);
    for (const step of node.fallback) {
      if (step.kind === 'human') add(step.queueId, `${node.id} fallback`);
      if (step.kind === 'default' && step.target?.kind === 'human') add(step.target.queueId, `${node.id} fallback`);
    }
  }
  const holdSteps = (hold: { onTimeout: { kind: string; queueId?: string }[] } | undefined, where: string) => {
    for (const step of hold?.onTimeout ?? []) if (step.kind === 'human' && step.queueId) add(step.queueId, where);
  };
  holdSteps(draft.transfer?.hold, 'point hold');
  for (const target of draft.transfer?.targets ?? []) {
    if (target.destination.kind === 'human') add(target.destination.queueId, `transfer ${target.key}`);
    holdSteps(target.hold, `hold of ${target.key}`);
  }
  return used;
}

export type Readiness = { tone: 'ok' | 'warn' | 'danger'; label: string };

/** Whether a bound queue can take callers right now, in words (never colour alone). */
export function queueReadiness(
  record: QueueRecord | undefined,
  status: HumanQueueStatus | undefined,
): Readiness {
  if (!record) return { tone: 'danger', label: 'Queue not found' };
  if (!status?.enabled) return { tone: 'warn', label: 'Human queues are off' };
  if (record.definition.kind === 'external')
    return status.webhookEnabled ? { tone: 'ok', label: 'Ready' } : { tone: 'warn', label: 'Webhooks are off' };
  if (!status.managedAvailable) return { tone: 'warn', label: 'No room server' };
  return record.stats.online > 0 ? { tone: 'ok', label: `${record.stats.online} online` } : { tone: 'warn', label: 'No operators online' };
}
