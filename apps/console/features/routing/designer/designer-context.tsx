'use client';
import { createContext, useContext } from 'react';
import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import type { IssueIndex } from '../../../lib/derive/routing-issue-index';
import type { Load } from '../../../lib/data/use-routing-load';
import type { HumanQueueStatus } from '../../../lib/types/desk';
import type { QueueRecord } from '../../../lib/types/queues';
import type {
  AgentOption,
  AudioRecord,
  PoolRecord,
  RoutingStatus,
} from '../../../lib/types/routing';

/** What every designer editor reads besides its own value: reference data, flags, role, issues. */
export interface DesignerEnv {
  draft: RoutingPointDraft;
  edit: (change: (current: RoutingPointDraft) => RoutingPointDraft) => void;
  index: IssueIndex;
  canEdit: boolean;
  status: RoutingStatus;
  pools: PoolRecord[];
  agents: Load<AgentOption[]>;
  credentials: { id: string; label: string }[];
  queues: QueueRecord[];
  queueStatus?: HumanQueueStatus;
  audio: AudioRecord[];
}

const Context = createContext<DesignerEnv | null>(null);
export const DesignerProvider = Context.Provider;
export function useDesigner(): DesignerEnv {
  const env = useContext(Context);
  if (!env) throw new Error('Designer editors render inside a DesignerProvider');
  return env;
}

/** The names the tree shows for ids: pools by id, agents by id. */
export function useNames() {
  const { pools, agents } = useDesigner();
  return {
    pools: new Map(pools.map((p) => [p.id, p.definition.name])),
    agents: new Map((agents.status === 'ready' ? agents.data : []).map((a) => [a.id, a.name])),
  };
}
