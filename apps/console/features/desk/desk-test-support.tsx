import { render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import type { DeskStreamOptions } from '../../lib/data/desk-stream';
import type {
  DeskAcceptResult,
  DeskMe,
  HumanTicketView,
  TicketContext,
} from '../../lib/types/desk';

/** Shared mocks and fixtures for the operator desk tests (split by scenario to stay readable). */
export const api = {
  me: vi.fn(),
  roomStatus: vi.fn(),
  tickets: vi.fn(),
  setPresence: vi.fn(),
  heartbeat: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  token: vi.fn(),
  context: vi.fn(),
  command: vi.fn(),
  wrapUp: vi.fn(),
  release: vi.fn(),
};
export const stream = { options: undefined as DeskStreamOptions | undefined, closed: 0 };
export const room = {
  client: undefined as import('@winsendotai/ovo-ui/room').FakeRoomClient | undefined,
  probe: vi.fn(),
};

export const deskApiModule = () => ({ deskApi: api });
export const deskStreamModule = (original: typeof import('../../lib/data/desk-stream')) => ({
  ...original,
  openDeskStream: vi.fn((options: DeskStreamOptions) => {
    stream.options = options;
    options.onStatus('live');
    return () => {
      stream.closed += 1;
    };
  }),
});
export const roomModule = (original: typeof import('@winsendotai/ovo-ui/room')) => ({
  ...original,
  createRoomClient: vi.fn(async () => room.client!),
  probeMicrophone: room.probe,
  listAudioDevices: vi.fn(async () => ({
    inputs: [{ id: 'mic-1', label: 'Headset' }],
    outputs: [],
  })),
});

export const actualRoom = () =>
  vi.importActual<typeof import('@winsendotai/ovo-ui/room')>('@winsendotai/ovo-ui/room');

export const ticket = (id: string, patch: Partial<HumanTicketView> = {}): HumanTicketView => ({
  id,
  queueId: 'q1',
  queueKey: 'support',
  queueName: 'Support desk',
  kind: 'managed',
  mode: 'OPEN_PICKUP',
  status: 'waiting',
  version: 1,
  priority: 0,
  language: 'hi',
  callerMasked: '••••4321',
  createdAt: '2026-10-15T10:00:00.000Z',
  waitMs: 5_000,
  offeredToMe: false,
  ...patch,
});

export const queue = (patch: Partial<DeskMe['queues'][number]> = {}): DeskMe['queues'][number] => ({
  id: 'q1',
  name: 'Support desk',
  assignment: 'OPEN_PICKUP',
  returnTargets: [],
  wrapUp: { required: false, dispositions: [] },
  ...patch,
});

export const me = (patch: Partial<DeskMe> = {}): DeskMe => ({
  profile: {
    userId: 'u1',
    displayName: 'Asha',
    enabled: true,
    teamIds: ['support'],
    languages: ['hi'],
    capacity: 1,
  },
  status: 'AVAILABLE',
  queues: [queue()],
  roomProvider: { provider: 'fake', serverUrl: 'wss://room.test' },
  presenceTtlSeconds: 30,
  stats: { handledToday: 4, activeNow: 0, onlineOperators: 2 },
  ...patch,
});

export const context: TicketContext = {
  callId: 'call-abcdef123456',
  brief: 'Language: Hindi. Intent: billing.',
  summary: 'Caller disputes a late fee.',
  language: 'hi',
  intent: 'billing',
  routePath: ['intent', 'billing'],
  caller: { number: '+919800004321' },
  transcript: [{ role: 'caller', text: 'I was charged twice' }],
  variables: { account_id: 'A-77' },
  returnTargets: [],
};

export const accepted = (patch: Partial<DeskAcceptResult> = {}): DeskAcceptResult => ({
  ticket: ticket('t1', { status: 'accepted', version: 2, assignedOperatorId: 'u1' }),
  room: {
    provider: 'fake',
    serverUrl: 'wss://room.test',
    roomName: 'ovo-hq-t1',
    identity: 'op:u1',
    role: 'operator',
    token: 'jwt',
    expiresAt: '2026-10-15T10:02:00.000Z',
  },
  context,
  ...patch,
});

export async function setup(
  options: { me?: DeskMe; tickets?: HumanTicketView[]; mine?: HumanTicketView[] } = {},
) {
  api.me.mockResolvedValue(options.me ?? me());
  api.roomStatus.mockResolvedValue({
    enabled: true,
    webhookEnabled: false,
    managedAvailable: true,
    room: { configured: true, provider: 'fake', reachable: true },
  });
  api.tickets.mockImplementation(async (scope: string) =>
    scope === 'queue' ? (options.tickets ?? [ticket('t1')]) : (options.mine ?? []),
  );
  // Imported here, not at the top: the mock factories import this file, and desk-view imports them.
  const { DeskView } = await import('./desk-view');
  render(<DeskView />);
  await screen.findByRole('heading', { name: 'Operator desk' });
}

/** Resets every mock and installs a fresh fake room before each test. */
export async function resetDesk() {
  for (const mock of Object.values(api)) mock.mockReset();
  room.probe.mockReset();
  stream.options = undefined;
  stream.closed = 0;
  room.client = (await actualRoom()).createFakeRoomClient();
  api.heartbeat.mockResolvedValue(undefined);
  api.context.mockResolvedValue(context);
  vi.stubGlobal('HTMLDialogElement', HTMLDialogElement);
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
