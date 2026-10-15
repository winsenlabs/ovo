import type { RoomGrant } from '@winsendotai/ovo-ui/room';
import { apiRequest, items } from '../api';
import type {
  DeskAcceptResult,
  DeskMe,
  HumanQueueStatus,
  HumanTicketView,
  OperatorStatus,
  TicketContext,
} from '../types/desk';

export type DeskCommand = { kind: 'end_call' } | { kind: 'return_to_agent'; target: string };
export interface WrapUp {
  disposition?: string;
  note?: string;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});
const ticket = (id: string) => `/desk/tickets/${encodeURIComponent(id)}`;

/** The `/v1/desk/*` calls, one function each, so screens and tests share one place for paths. */
export const deskApi = {
  me: async () => (await apiRequest<DeskMe>('/desk/me')).data,
  roomStatus: async () => (await apiRequest<HumanQueueStatus>('/human-queues/status')).data,
  tickets: async (scope: 'queue' | 'mine') =>
    items<HumanTicketView>((await apiRequest<unknown>(`/desk/tickets?scope=${scope}`)).data),
  setPresence: async (status: OperatorStatus) =>
    (await apiRequest<{ status: OperatorStatus }>('/desk/presence', json('PUT', { status }))).data,
  heartbeat: async () => void (await apiRequest('/desk/heartbeat', json('POST', {}))),
  accept: async (id: string, expectedVersion: number, idempotencyKey: string) =>
    (
      await apiRequest<DeskAcceptResult>(
        `${ticket(id)}/accept`,
        json('POST', { expectedVersion, idempotencyKey }),
      )
    ).data,
  decline: async (id: string, expectedVersion: number) =>
    void (await apiRequest(`${ticket(id)}/decline`, json('POST', { expectedVersion }))),
  token: async (id: string) =>
    (await apiRequest<{ room: RoomGrant }>(`${ticket(id)}/token`, json('POST', {}))).data.room,
  context: async (id: string) => (await apiRequest<TicketContext>(`${ticket(id)}/context`)).data,
  command: async (id: string, command: DeskCommand) =>
    (await apiRequest<{ seq: number }>(`${ticket(id)}/commands`, json('POST', command))).data,
  wrapUp: async (id: string, wrap: WrapUp) =>
    void (await apiRequest(`${ticket(id)}/wrap-up`, json('PUT', wrap))),
  release: async (id: string) => void (await apiRequest(`${ticket(id)}/release`, json('POST', {}))),
};
