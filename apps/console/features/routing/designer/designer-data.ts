'use client';
import { useMemo } from 'react';
import { queuesApi } from '../../../lib/data/queues-api';
import { routingApi } from '../../../lib/data/routing-api';
import { useRoutingLoad } from '../../../lib/data/use-routing-load';
import { numbersOfPoint } from '../../../lib/derive/routing-numbers';
import type { NumberRow, ReleaseSummary } from '../../../lib/types/routing';
import type { DesignerEnv } from './designer-context';

const ifReady = <T>(state: { status: string; data?: T }, fallback: T): T =>
  state.status === 'ready' ? (state as { data: T }).data : fallback;

/**
 * The reference data the designer's editors read besides the draft: pools, agents, secrets,
 * queues, hold clips, numbers and releases. Each loads on its own and degrades to empty, so a slow
 * or failing list never blocks editing the tree.
 */
export function useDesignerData(pointId: string, enabled: boolean, refresh: number) {
  const off = <T,>(load: () => Promise<T>, empty: T) => () => (enabled ? load() : Promise.resolve(empty));
  const pools = useRoutingLoad(off(() => routingApi.pools(), []), [enabled]);
  const agents = useRoutingLoad(off(() => routingApi.agents(), []), [enabled]);
  const credentials = useRoutingLoad(() => queuesApi.credentials().catch(() => []), []);
  const queues = useRoutingLoad(() => queuesApi.list().catch(() => []), []);
  const queueStatus = useRoutingLoad(() => queuesApi.status().catch(() => undefined), []);
  const audio = useRoutingLoad(off(() => routingApi.audio().catch(() => []), []), [enabled, refresh]);
  const numbers = useRoutingLoad(off(() => routingApi.numbers(), []), [enabled, refresh]);
  const releases = useRoutingLoad(off(() => routingApi.releases(pointId), []), [enabled, pointId, refresh]);
  const releaseList: ReleaseSummary[] = ifReady(releases.state, []);
  const numberList: NumberRow[] = ifReady(numbers.state, []);
  const latest = releaseList.reduce<ReleaseSummary | undefined>((best, r) => (!best || r.version > best.version ? r : best), undefined);
  const mine = useMemo(() => numbersOfPoint(numberList, pointId), [numberList, pointId]);
  const reference: Pick<DesignerEnv, 'pools' | 'agents' | 'credentials' | 'queues' | 'queueStatus' | 'audio'> = {
    pools: ifReady(pools.state, []),
    agents: agents.state.status === 'error' ? { status: 'error', message: agents.state.message } : agents.state.status === 'ready' ? agents.state : { status: 'loading' },
    credentials: ifReady(credentials.state, []),
    queues: ifReady(queues.state, []),
    queueStatus: ifReady(queueStatus.state, undefined),
    audio: ifReady(audio.state, []),
  };
  return { reference, releases: releaseList, latest, numbers: numberList, numbersLoaded: numbers.state.status === 'ready', mine };
}
