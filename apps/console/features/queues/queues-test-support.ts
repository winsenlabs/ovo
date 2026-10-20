import { vi } from 'vitest';
import { blankQueue } from '../../lib/derive/queues';
import type { HumanQueueStatus } from '../../lib/types/desk';
import type {
  ExternalQueueDefinition,
  ManagedQueueDefinition,
  OperatorRow,
  QueueRecord,
} from '../../lib/types/queues';

/** Shared fixtures and the mocked administration API for the queue screens' tests. */
export const queuesApi = {
  status: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
  testWebhook: vi.fn(),
  operators: vi.fn(),
  saveOperator: vi.fn(),
  users: vi.fn(),
  credentials: vi.fn(),
};
export const queuesApiModule = () => ({ queuesApi });

/** The activity call lives with the routing client; `vi.mock('../../lib/data/routing-api', activityApiModule)`. */
export const activityApi = { queueActivity: vi.fn() };
export const activityApiModule = async () => {
  const actual = await vi.importActual<typeof import('../../lib/data/routing-api')>(
    '../../lib/data/routing-api',
  );
  return { ...actual, routingApi: { ...actual.routingApi, ...activityApi } };
};

export const roomStatus = (patch: Partial<HumanQueueStatus> = {}): HumanQueueStatus => ({
  enabled: true,
  webhookEnabled: true,
  managedAvailable: true,
  room: { configured: true, provider: 'fake', reachable: true },
  ...patch,
});

const stats = { waiting: 2, offered: 1, oldestWaitMs: 95_000, online: 3, handled24h: 40 };

export const managedRecord = (patch: Partial<QueueRecord> = {}): QueueRecord => ({
  id: 'q-desk',
  version: 3,
  definition: {
    ...(blankQueue('managed') as ManagedQueueDefinition),
    name: 'Support desk',
    teamIds: ['support'],
  },
  stats,
  usedBy: ['point-1'],
  updatedAt: '2026-10-15T09:00:00.000Z',
  ...patch,
});

export const externalRecord = (patch: Partial<QueueRecord> = {}): QueueRecord => ({
  id: 'q-acd',
  version: 5,
  definition: {
    ...(blankQueue('external') as ExternalQueueDefinition),
    name: 'Acme ACD',
    webhook: {
      ...(blankQueue('external') as ExternalQueueDefinition).webhook,
      url: 'https://acd.example.com/ovo/handoff',
      credentialId: 'acd-hmac',
    },
    destination: {
      allowE164Prefixes: ['+9140'],
      allowSipHosts: [],
      allowInsecureSip: false,
      allowedHeaders: [],
    },
  },
  stats: { ...stats, waiting: 0, offered: 0, oldestWaitMs: 0, online: 0 },
  usedBy: [],
  updatedAt: '2026-10-15T09:00:00.000Z',
  ...patch,
});

export const operator = (patch: Partial<OperatorRow> = {}): OperatorRow => ({
  userId: 'u1',
  label: 'Asha',
  email: 'asha@example.test',
  displayName: 'Asha',
  enabled: true,
  teamIds: ['support'],
  languages: ['en', 'hi'],
  capacity: 2,
  status: 'AVAILABLE',
  lastSeenAt: '2026-10-15T09:59:00.000Z',
  active: 1,
  ...patch,
});

export function resetQueues() {
  for (const mock of [...Object.values(queuesApi), ...Object.values(activityApi)]) mock.mockReset();
  queuesApi.status.mockResolvedValue(roomStatus());
  queuesApi.list.mockResolvedValue([managedRecord(), externalRecord()]);
  queuesApi.credentials.mockResolvedValue([{ id: 'acd-hmac', label: 'ACD signing secret' }]);
  queuesApi.operators.mockResolvedValue([operator()]);
  queuesApi.users.mockResolvedValue([
    { id: 'u1', email: 'asha@example.test', label: 'Asha', disabled: false },
    { id: 'u2', email: 'ravi@example.test', label: 'Ravi', disabled: false },
  ]);
  queuesApi.preview.mockResolvedValue({ body: { callId: 'call-sample' }, issues: [] });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
