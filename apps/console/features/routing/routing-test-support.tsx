import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { vi } from 'vitest';
import { useState, type ReactNode } from 'react';
import { indexIssues } from '../../lib/derive/routing-anchor';
import { clientIssues } from '../../lib/derive/routing-issues';
import {
  agents,
  audio,
  IDS,
  numbers,
  point,
  pools,
  release,
  releases,
  stats,
  utilisation,
} from '../../e2e/fixtures/routing-data.mjs';
import { simulate } from '../../e2e/fixtures/routing-simulate.mjs';
import type { AudioRecord, PoolRecord } from '../../lib/types/routing';
import type { RoutingSimulationResult } from '../../lib/types/routing-simulate';
import { DesignerProvider, type DesignerEnv } from './designer/designer-context';

/** The fixture API's data, reused so unit tests and e2e agree on what a routing point looks like. */
export { IDS };
export { sampleDraft } from '../../lib/derive/routing-support.test-helpers';

/** The fixture's pools as the wire type the screens read. */
export const typedPools = () => pools() as unknown as PoolRecord[];
/** The fixture router's answer, typed as the simulator's result. */
export const typedSimulate = (body: unknown) => simulate(body) as unknown as RoutingSimulationResult;

/** Every `routingApi` call as a mock; `resetRouting` gives each a fixture-backed default. */
export const routingApi = {
  status: vi.fn(),
  stats: vi.fn(),
  points: vi.fn(),
  point: vi.fn(),
  createPoint: vi.fn(),
  savePoint: vi.fn(),
  removePoint: vi.fn(),
  validate: vi.fn(),
  previewPublish: vi.fn(),
  publish: vi.fn(),
  releases: vi.fn(),
  release: vi.fn(),
  pools: vi.fn(),
  pool: vi.fn(),
  createPool: vi.fn(),
  savePool: vi.fn(),
  removePool: vi.fn(),
  utilisationAll: vi.fn(),
  utilisation: vi.fn(),
  explain: vi.fn(),
  audio: vi.fn(),
  audioOne: vi.fn(),
  uploadAudio: vi.fn(),
  audioBlob: vi.fn(),
  removeAudio: vi.fn(),
  simulate: vi.fn(),
  agents: vi.fn(),
  agentReleases: vi.fn(),
  numbers: vi.fn(),
  bindNumber: vi.fn(),
};
export const routingApiModule = async (importActual: () => Promise<Record<string, unknown>>) => ({
  ...(await importActual()),
  routingApi,
});

export const ENABLED_STATUS = {
  enabled: true,
  externalEnabled: true,
  transferEnabled: true,
  humanQueueEnabled: true,
  simulate: { enabled: true, liveLlm: false, liveExternal: false },
};

export function resetRouting() {
  for (const mock of Object.values(routingApi)) mock.mockReset();
  routingApi.status.mockResolvedValue(ENABLED_STATUS);
  routingApi.stats.mockResolvedValue(stats('24h'));
  routingApi.points.mockResolvedValue(
    [point(IDS.point), point(IDS.point2)].map((p) => ({
      ...p,
      summary: {
        nodes: 2,
        pools: 2,
        languages: 3,
        humanQueues: 1,
        latestRelease: { id: IDS.r3, version: 3, digest: 'c', draftVersion: 3 },
        published: false,
        numbers: 2,
      },
    })),
  );
  routingApi.point.mockResolvedValue({ point: point(IDS.point), version: 4 });
  routingApi.savePoint.mockImplementation(async (_id: string, draft: unknown, version: number) => ({
    ...point(IDS.point),
    draft,
    draftVersion: version + 1,
  }));
  routingApi.validate.mockResolvedValue([]);
  routingApi.releases.mockResolvedValue(releases());
  routingApi.release.mockImplementation(async (id: string) => release(id));
  routingApi.pools.mockResolvedValue(pools());
  routingApi.pool.mockImplementation(async (id: string) => ({
    pool: pools().find((p: { id: string }) => p.id === id) ?? pools()[0],
    version: 2,
  }));
  routingApi.savePool.mockImplementation(
    async (id: string, definition: unknown, version: number) => ({
      ...pools()[0],
      id,
      definition,
      version: version + 1,
    }),
  );
  routingApi.utilisationAll.mockResolvedValue(
    pools().map((p: { id: string }) => utilisation(p.id)),
  );
  routingApi.utilisation.mockImplementation(async (id: string) => utilisation(id));
  routingApi.audio.mockResolvedValue(audio());
  routingApi.agents.mockResolvedValue(
    agents().map((a: { id: string; config: { name: string } }) => ({
      id: a.id,
      name: a.config.name,
    })),
  );
  routingApi.agentReleases.mockResolvedValue([{ id: IDS.r1, version: 1 }]);
  routingApi.numbers.mockResolvedValue(numbers());
  routingApi.simulate.mockImplementation(async (body: unknown) => simulate(body));
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}

import { sampleDraft as sampleDraftValue } from '../../lib/derive/routing-support.test-helpers';

/** Renders editors that read the designer context, with a real working copy they edit. */
export function DesignerHarness({
  children,
  draft = sampleDraftValue(),
  canEdit = true,
  onDraft,
  env = {},
}: {
  children: ReactNode;
  draft?: RoutingPointDraft;
  canEdit?: boolean;
  onDraft?: (draft: RoutingPointDraft) => void;
  env?: Partial<DesignerEnv>;
}) {
  const [current, setCurrent] = useState(draft);
  const value: DesignerEnv = {
    draft: current,
    edit: (change) =>
      setCurrent((d) => {
        const next = change(d);
        onDraft?.(next);
        return next;
      }),
    index: indexIssues(current, clientIssues(current)),
    canEdit,
    status: ENABLED_STATUS,
    pools: typedPools(),
    agents: {
      status: 'ready',
      data: agents().map((a: { id: string; config: { name: string } }) => ({
        id: a.id,
        name: a.config.name,
      })),
    },
    credentials: [{ id: 'cred-acd', label: 'ACD signing secret' }],
    queues: [],
    audio: audio() as unknown as AudioRecord[],
    ...env,
  };
  return <DesignerProvider value={value}>{children}</DesignerProvider>;
}
