import { apiRequest, items } from '../api';
import { json } from './json-init';
import type { HumanQueueStatus } from '../types/desk';
import type {
  ActivityWindow,
  OperatorRow,
  QueueActivity,
  PreviewResult,
  QueueDefinition,
  QueueRecord,
  WebhookTestResult,
} from '../types/queues';

const path = (id: string) => `/human-queues/${encodeURIComponent(id)}`;

/** The `/v1/human-queues/*` administration calls. */
export const queuesApi = {
  status: async () => (await apiRequest<HumanQueueStatus>('/human-queues/status')).data,
  list: async () => items<QueueRecord>((await apiRequest<unknown>('/human-queues')).data),
  create: async (definition: QueueDefinition) =>
    (await apiRequest<QueueRecord>('/human-queues', json('POST', { definition }))).data,
  update: async (id: string, definition: QueueDefinition, version: number) =>
    (await apiRequest<QueueRecord>(path(id), json('PUT', { definition }, version))).data,
  remove: async (id: string, version: number) =>
    void (await apiRequest(path(id), json('DELETE', undefined, version))),
  preview: async (spec: unknown, policy: unknown) =>
    (await apiRequest<PreviewResult>('/human-queues/preview', json('POST', { spec, policy }))).data,
  activity: async (id: string, window: ActivityWindow) =>
    (await apiRequest<QueueActivity>(`${path(id)}/activity?window=${window}`)).data,
  testWebhook: async (id: string) =>
    (await apiRequest<WebhookTestResult>(`${path(id)}/test-webhook`, json('POST', {}))).data,
  operators: async () =>
    items<OperatorRow>((await apiRequest<unknown>('/human-queues/operators')).data),
  /** Sends the profile only: the directory's name and email and the live presence are not ours to write. */
  saveOperator: async (userId: string, profile: Omit<OperatorRow, 'status' | 'active'>) =>
    void (await apiRequest(
      `/human-queues/operators/${encodeURIComponent(userId)}`,
      json('PUT', {
        userId,
        displayName: profile.displayName,
        enabled: profile.enabled,
        teamIds: profile.teamIds,
        languages: profile.languages,
        capacity: profile.capacity,
      }),
    )),
  users: async () =>
    items<{ id: string; email: string; label: string; disabled: boolean }>(
      (await apiRequest<unknown>('/users')).data,
    ),
  credentials: async () =>
    items<{ id: string; label: string }>((await apiRequest<unknown>('/credentials')).data),
};
