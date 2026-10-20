import type { HumanQueue, OperatorProfile } from '@winsendotai/ovo-contracts';
import type { OperationsService } from '@winsendotai/ovo-plugin-operations';
import type { ApiHumanQueueService, HumanQueueRouteDependencies } from './human-queue-support.ts';

/** The queues an operator may take: desk queues whose teams include one of theirs (or none set). */
export function queuesFor(profile: OperatorProfile, all: readonly HumanQueue[]) {
  return all.flatMap((row) =>
    row.definition.kind === 'managed' &&
    (row.definition.teamIds.length === 0 ||
      row.definition.teamIds.some((team) => profile.teamIds.includes(team)))
      ? [{ id: row.id, definition: row.definition }]
      : [],
  );
}

const humanise = (key: string) => {
  const spaced = key.replace(/[-_]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/**
 * What an operator calls a send-back target: the label the routing point's catalogue gives it
 * (the first language it has one in), else the key made readable. Labels live in the point draft,
 * so a queue no point binds, or routing switched off, falls back to the key.
 */
async function targetLabels(
  operations: OperationsService | undefined,
  queues: ApiHumanQueueService,
  queueId: string,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    for (const pointId of await queues.queues.usedBy(queueId)) {
      const point = await operations?.routing.points.get(pointId);
      for (const target of point?.draft.transfer?.targets ?? []) {
        const line = target.label && Object.values(target.label)[0];
        if (line && !labels.has(target.key)) labels.set(target.key, line);
      }
    }
  } catch {
    // Labels are a courtesy; the keys still work.
  }
  return labels;
}

/** Everything `GET /v1/desk/me` says about the operator's queues. */
export async function deskQueues(
  input: Pick<HumanQueueRouteDependencies, 'operations'>,
  queues: ApiHumanQueueService,
  profile: OperatorProfile,
) {
  const all = await queues.queues.list(200);
  return Promise.all(
    queuesFor(profile, all).map(async ({ id, definition }) => {
      const labels = await targetLabels(input.operations, queues, id);
      return {
        id,
        name: definition.name,
        assignment: definition.assignment,
        returnTargets: definition.returnTargets.map((key) => ({
          key,
          label: labels.get(key) ?? humanise(key),
        })),
        wrapUp: definition.wrapUp,
      };
    }),
  );
}

/** The live numbers on the KPI strip: my load, who is online with me, what my queues handled. */
export async function deskStats(
  queues: ApiHumanQueueService,
  profile: OperatorProfile,
  queueIds: readonly string[],
) {
  const [operators, stats] = await Promise.all([
    queues.operators.list(),
    Promise.all(queueIds.map((id) => queues.queues.stats(id))),
  ]);
  const mine = operators.find((row) => row.userId === profile.userId);
  const shares = (team: readonly string[]) =>
    profile.teamIds.length === 0 ||
    team.length === 0 ||
    team.some((id) => profile.teamIds.includes(id));
  return {
    status: mine?.status ?? 'OFFLINE',
    stats: {
      handledToday: stats.reduce((sum, row) => sum + row.handled24h, 0),
      activeNow: mine?.active ?? 0,
      onlineOperators: operators.filter(
        (row) => row.enabled && row.status === 'AVAILABLE' && shares(row.teamIds),
      ).length,
    },
  };
}
