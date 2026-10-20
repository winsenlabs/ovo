import {
  Emitter,
  type RoomCaption,
  type RoomClient,
  type RoomConnectionState,
  type RoomGrant,
  type RoomLevels,
} from './client.ts';

/**
 * A deterministic room client for Vitest and the Playwright fixtures: no network, no microphone.
 * Tests drive it through the `simulate*` methods; `connect` lands in `connected` and the caller
 * joins a tick later unless `callerJoins` is false.
 */
export interface FakeRoomClient extends RoomClient {
  readonly grants: readonly RoomGrant[];
  readonly muted: boolean;
  readonly volume: number;
  readonly inputDevice?: string;
  readonly outputDevice?: string;
  readonly state: RoomConnectionState;
  /** The next `connect` rejects with this message (then behaves normally again). */
  failNextConnect(message: string): void;
  simulateState(state: RoomConnectionState): void;
  simulateCallerPresent(present: boolean): void;
  simulateCaption(caption: RoomCaption): void;
  simulateLevels(levels: RoomLevels): void;
}

export interface FakeRoomOptions {
  /** The caller's seat joins as soon as the operator connects (default). */
  callerJoins?: boolean;
}

export function createFakeRoomClient(options: FakeRoomOptions = {}): FakeRoomClient {
  const states = new Emitter<RoomConnectionState>();
  const captions = new Emitter<RoomCaption>();
  const presence = new Emitter<boolean>();
  const grants: RoomGrant[] = [];
  let state: RoomConnectionState = 'idle';
  let failure: string | undefined;
  let levels: RoomLevels = { input: 0, output: 0 };
  const client = {
    provider: 'fake',
    grants,
    muted: false,
    volume: 1,
    inputDevice: undefined as string | undefined,
    outputDevice: undefined as string | undefined,
    get state() {
      return state;
    },
    async connect(grant: RoomGrant) {
      grants.push(grant);
      state = 'connecting';
      states.emit(state);
      if (failure !== undefined) {
        const message = failure;
        failure = undefined;
        state = 'disconnected';
        states.emit(state);
        throw new Error(message);
      }
      state = 'connected';
      states.emit(state);
      if (options.callerJoins !== false) presence.emit(true);
    },
    async disconnect() {
      if (state === 'idle' || state === 'disconnected') return;
      state = 'disconnected';
      states.emit(state);
      presence.emit(false);
      levels = { input: 0, output: 0 };
    },
    async setMuted(muted: boolean) {
      client.muted = muted;
    },
    setVolume(volume: number) {
      client.volume = Math.min(1, Math.max(0, volume));
    },
    async setInputDevice(deviceId: string) {
      client.inputDevice = deviceId;
    },
    async setOutputDevice(deviceId: string) {
      client.outputDevice = deviceId;
    },
    onState: (listener: (value: RoomConnectionState) => void) => states.on(listener),
    onCaption: (listener: (value: RoomCaption) => void) => captions.on(listener),
    onCallerPresent: (listener: (value: boolean) => void) => presence.on(listener),
    levels: () => levels,
    failNextConnect(message: string) {
      failure = message;
    },
    simulateState(next: RoomConnectionState) {
      state = next;
      states.emit(next);
    },
    simulateCallerPresent: (present: boolean) => presence.emit(present),
    simulateCaption: (caption: RoomCaption) => captions.emit(caption),
    simulateLevels(next: RoomLevels) {
      levels = next;
    },
  };
  return client;
}
