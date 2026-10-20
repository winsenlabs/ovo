import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyMicrophoneFailure,
  createFakeRoomClient,
  createRoomClient,
  listAudioDevices,
  MicrophoneError,
  probeMicrophone,
  registerRoomAdapter,
  UnsupportedRoomProviderError,
  type MediaAccess,
  type RoomCaption,
  type RoomConnectionState,
  type RoomGrant,
} from '../src/room/index.ts';
import {
  CALLER_IDENTITY,
  CAPTION_TOPIC,
  createBrowserRoomClient,
  parseCaption,
} from '../src/room/adapter-browser.ts';

const grant: RoomGrant = {
  provider: 'fake',
  serverUrl: 'wss://room.example.test',
  roomName: 'ovo-hq-1',
  identity: 'op:user-1',
  role: 'operator',
  token: 'jwt',
  expiresAt: '2026-10-15T10:02:00.000Z',
};

describe('fake room client', () => {
  it('connects, reports the caller joining, and replays scripted captions', async () => {
    const client = createFakeRoomClient();
    const states: RoomConnectionState[] = [];
    const present: boolean[] = [];
    const captions: RoomCaption[] = [];
    client.onState((state) => states.push(state));
    client.onCallerPresent((value) => present.push(value));
    client.onCaption((caption) => captions.push(caption));
    await client.connect(grant);
    client.simulateCaption({ role: 'caller', text: 'hello', final: true, at: 5 });
    await client.setMuted(true);
    client.setVolume(4);
    await client.disconnect();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
    expect(present).toEqual([true, false]);
    expect(captions).toEqual([{ role: 'caller', text: 'hello', final: true, at: 5 }]);
    expect(client.muted).toBe(true);
    expect(client.volume).toBe(1);
    expect(client.grants).toEqual([grant]);
  });

  it('can hold the caller back and fail one connect', async () => {
    const client = createFakeRoomClient({ callerJoins: false });
    const present: boolean[] = [];
    client.onCallerPresent((value) => present.push(value));
    client.failNextConnect('boom');
    await expect(client.connect(grant)).rejects.toThrow('boom');
    await client.connect(grant);
    expect(present).toEqual([]);
    client.simulateCallerPresent(true);
    expect(present).toEqual([true]);
  });

  it('stops delivering to an unsubscribed listener', async () => {
    const client = createFakeRoomClient();
    const seen: string[] = [];
    const off = client.onCaption((caption) => seen.push(caption.text));
    client.simulateCaption({ role: 'agent', text: 'a', final: true, at: 1 });
    off();
    client.simulateCaption({ role: 'agent', text: 'b', final: true, at: 2 });
    expect(seen).toEqual(['a']);
  });
});

describe('room client factory', () => {
  it('builds the fake by provider id and rejects an unknown provider', async () => {
    expect((await createRoomClient('fake')).provider).toBe('fake');
    await expect(createRoomClient('nope')).rejects.toBeInstanceOf(UnsupportedRoomProviderError);
  });

  it('lets a test register and then undo an adapter', async () => {
    const fake = createFakeRoomClient();
    const undo = registerRoomAdapter('custom', async () => fake);
    expect(await createRoomClient('custom')).toBe(fake);
    undo();
    await expect(createRoomClient('custom')).rejects.toBeInstanceOf(UnsupportedRoomProviderError);
  });
});

describe('parseCaption', () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  it('accepts the documented shape and clips long text', () => {
    expect(
      parseCaption(encode({ role: 'operator', text: 'x'.repeat(900), final: false, at: 3 })),
    ).toEqual({
      role: 'operator',
      text: 'x'.repeat(500),
      final: false,
      at: 3,
    });
  });
  it('drops anything else, including non-JSON', () => {
    expect(parseCaption(encode({ role: 'admin', text: 't', final: true, at: 1 }))).toBeUndefined();
    expect(parseCaption(encode({ role: 'caller', text: 5, final: true, at: 1 }))).toBeUndefined();
    expect(parseCaption(new TextEncoder().encode('not json'))).toBeUndefined();
  });
});

/** A just-enough stand-in for the room SDK: the adapter's behaviour, not the SDK's, is under test. */
function fakeSdk() {
  const events = {
    ConnectionStateChanged: 'cs',
    TrackSubscribed: 'ts',
    TrackUnsubscribed: 'tu',
    ParticipantConnected: 'pc',
    ParticipantDisconnected: 'pd',
    DataReceived: 'dr',
  };
  const rooms: FakeRoom[] = [];
  const control: { connectError?: Error } = {};
  class FakeRoom {
    handlers = new Map<string, (...args: never[]) => void>();
    remoteParticipants = new Map<string, { identity: string; audioLevel: number }>();
    localParticipant = { audioLevel: 0.25, setMicrophoneEnabled: vi.fn(async () => undefined) };
    connect = vi.fn(async (_url: string, _token: string, _options?: unknown) => {
      const error = control.connectError;
      control.connectError = undefined;
      if (error) throw error;
    });
    disconnect = vi.fn(async () => undefined);
    startAudio = vi.fn(async () => undefined);
    switchActiveDevice = vi.fn(async () => true);
    constructor() {
      rooms.push(this);
    }
    on(name: string, handler: (...args: never[]) => void) {
      this.handlers.set(name, handler);
      return this;
    }
    fire(name: string, ...args: unknown[]) {
      (this.handlers.get(name) as ((...a: unknown[]) => void) | undefined)?.(...args);
    }
  }
  const sdk = {
    Room: FakeRoom,
    RoomEvent: events,
    Track: { Kind: { Audio: 'audio' } },
    ConnectionState: {
      Connected: 'connected',
      Connecting: 'connecting',
      Reconnecting: 'reconnecting',
      SignalReconnecting: 'signalReconnecting',
      Disconnected: 'disconnected',
    },
  };
  return { sdk: sdk as never, rooms, events, control };
}

describe('browser room adapter', () => {
  const body = { append: vi.fn() };
  afterEach(() => {
    vi.unstubAllGlobals();
    body.append.mockReset();
  });

  it('joins with the grant, publishes the microphone and reports the caller already present', async () => {
    const { sdk, rooms } = fakeSdk();
    const client = createBrowserRoomClient(sdk);
    const room = () => rooms[0]!;
    const present: boolean[] = [];
    client.onCallerPresent((value) => present.push(value));
    const joined = client.connect(grant);
    await joined;
    expect(room().connect).toHaveBeenCalledWith(grant.serverUrl, grant.token, {
      autoSubscribe: true,
    });
    expect(room().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(room().startAudio).toHaveBeenCalled();
    expect(present).toEqual([]);
    room().remoteParticipants.set(CALLER_IDENTITY, { identity: CALLER_IDENTITY, audioLevel: 0.5 });
    room().fire('pc');
    expect(present).toEqual([true]);
    expect(client.levels()).toEqual({ input: 0.25, output: 0.5 });
    room().remoteParticipants.clear();
    room().fire('pd');
    expect(present).toEqual([true, false]);
  });

  it('maps connection states and never starts a call it could not join', async () => {
    const { sdk, rooms, control } = fakeSdk();
    const client = createBrowserRoomClient(sdk);
    const states: RoomConnectionState[] = [];
    client.onState((state) => states.push(state));
    await client.connect(grant);
    rooms[0]!.fire('cs', 'signalReconnecting');
    rooms[0]!.fire('cs', 'connected');
    rooms[0]!.fire('cs', 'disconnected');
    expect(states).toEqual(['connecting', 'reconnecting', 'connected', 'disconnected']);
    control.connectError = new Error('bad token');
    await expect(client.connect(grant)).rejects.toThrow('bad token');
    expect(rooms[1]!.disconnect).toHaveBeenCalled();
    expect(client.levels()).toEqual({ input: 0, output: 0 });
  });

  it('accepts captions only from the caller seat on the caption topic', async () => {
    const { sdk, rooms } = fakeSdk();
    const client = createBrowserRoomClient(sdk);
    const captions: RoomCaption[] = [];
    client.onCaption((caption) => captions.push(caption));
    await client.connect(grant);
    const payload = new TextEncoder().encode(
      JSON.stringify({ role: 'caller', text: 'hi', final: true, at: 9 }),
    );
    rooms[0]!.fire('dr', payload, { identity: 'op:someone-else' }, 0, CAPTION_TOPIC);
    rooms[0]!.fire('dr', payload, { identity: CALLER_IDENTITY }, 0, 'other.topic');
    expect(captions).toEqual([]);
    rooms[0]!.fire('dr', payload, { identity: CALLER_IDENTITY }, 0, CAPTION_TOPIC);
    expect(captions).toEqual([{ role: 'caller', text: 'hi', final: true, at: 9 }]);
  });

  it('attaches the caller audio, applies volume, and removes it on disconnect', async () => {
    const element = { volume: 1, style: { display: '' }, remove: vi.fn() };
    vi.stubGlobal('document', { body });
    const { sdk, rooms } = fakeSdk();
    const client = createBrowserRoomClient(sdk);
    await client.connect(grant);
    client.setVolume(0.4);
    const track = { kind: 'audio', attach: () => element, detach: () => [element] };
    rooms[0]!.fire('ts', track);
    expect(body.append).toHaveBeenCalledWith(element);
    expect(element.volume).toBe(0.4);
    client.setVolume(0.8);
    expect(element.volume).toBe(0.8);
    await client.setMuted(true);
    await client.setInputDevice('mic-2');
    await client.setOutputDevice('spk-2');
    expect(rooms[0]!.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    expect(rooms[0]!.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-2');
    expect(rooms[0]!.switchActiveDevice).toHaveBeenCalledWith('audiooutput', 'spk-2');
    await client.disconnect();
    expect(element.remove).toHaveBeenCalled();
    expect(rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
    await client.disconnect();
    expect(rooms[0]!.disconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-audio track', async () => {
    vi.stubGlobal('document', { body });
    const { sdk, rooms } = fakeSdk();
    const client = createBrowserRoomClient(sdk);
    await client.connect(grant);
    rooms[0]!.fire('ts', { kind: 'video', attach: vi.fn(), detach: vi.fn() });
    expect(body.append).not.toHaveBeenCalled();
  });
});

describe('microphone access', () => {
  const failing = (name: string): MediaAccess => ({
    getUserMedia: async () => {
      throw Object.assign(new Error('x'), { name });
    },
    enumerateDevices: async () => [],
  });

  it('classifies browser failures into the four states the UI has copy for', () => {
    expect(classifyMicrophoneFailure(Object.assign(new Error(), { name: 'NotAllowedError' }))).toBe(
      'denied',
    );
    expect(classifyMicrophoneFailure(Object.assign(new Error(), { name: 'NotFoundError' }))).toBe(
      'not_found',
    );
    expect(
      classifyMicrophoneFailure(Object.assign(new Error(), { name: 'NotReadableError' })),
    ).toBe('in_use');
    expect(classifyMicrophoneFailure('weird')).toBe('unsupported');
  });

  it('surfaces a permission refusal as a typed error', async () => {
    await expect(probeMicrophone(undefined, failing('NotAllowedError'))).rejects.toMatchObject({
      reason: 'denied',
    });
    await expect(probeMicrophone(undefined, failing('NotFoundError'))).rejects.toBeInstanceOf(
      MicrophoneError,
    );
  });

  it('lists inputs and outputs with fallback labels and skips the unlabelled default entry', async () => {
    const media: MediaAccess = {
      getUserMedia: async () => ({}) as MediaStream,
      enumerateDevices: async () =>
        [
          { kind: 'audioinput', deviceId: 'a', label: 'Headset' },
          { kind: 'audioinput', deviceId: 'b', label: '' },
          { kind: 'audiooutput', deviceId: 'c', label: 'Desk speaker' },
          { kind: 'videoinput', deviceId: 'v', label: 'Camera' },
          { kind: 'audioinput', deviceId: '', label: 'Hidden' },
        ] as MediaDeviceInfo[],
    };
    expect(await listAudioDevices(media)).toEqual({
      inputs: [
        { id: 'a', label: 'Headset' },
        { id: 'b', label: 'Microphone 2' },
      ],
      outputs: [{ id: 'c', label: 'Desk speaker' }],
    });
  });

  it('returns a silent meter, and stops every track, when there is no audio context', async () => {
    const stop = vi.fn();
    const media: MediaAccess = {
      getUserMedia: async () =>
        ({ getTracks: () => [{ stop }, { stop }] }) as unknown as MediaStream,
      enumerateDevices: async () => [],
    };
    const probe = await probeMicrophone('a', media);
    expect(probe.level()).toBe(0);
    probe.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
