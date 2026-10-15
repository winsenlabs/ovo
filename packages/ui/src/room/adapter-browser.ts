import type * as Sdk from 'livekit-client';
import {
  Emitter,
  type RoomCaption,
  type RoomClient,
  type RoomConnectionState,
  type RoomGrant,
  type RoomLevels,
} from './client.ts';

/** The one file in the console's dependency tree that names the self-hosted room server's SDK. */
type SdkModule = typeof Sdk;

/** The worker's seat joins every room under this identity and sends captions on this topic. */
export const CALLER_IDENTITY = 'caller';
export const CAPTION_TOPIC = 'ovo.caption';
/** Captions are rendered as text, so only the documented shape is accepted. */
const ROLES = new Set(['caller', 'operator', 'agent']);

/** A caption from the data channel, or undefined when it is not one of ours. */
export function parseCaption(payload: Uint8Array): RoomCaption | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    if (
      typeof value.role !== 'string' ||
      !ROLES.has(value.role) ||
      typeof value.text !== 'string' ||
      typeof value.final !== 'boolean' ||
      typeof value.at !== 'number'
    )
      return undefined;
    return {
      role: value.role as RoomCaption['role'],
      text: value.text.slice(0, 500),
      final: value.final,
      at: value.at,
    };
  } catch {
    return undefined;
  }
}

/** Audio only: the operator's microphone is published, the caller's track is attached and played. */
export function createBrowserRoomClient(sdk: SdkModule): RoomClient {
  const states = new Emitter<RoomConnectionState>();
  const captions = new Emitter<RoomCaption>();
  const presence = new Emitter<boolean>();
  const elements = new Set<HTMLMediaElement>();
  let room: Sdk.Room | undefined;
  let volume = 1;
  let callerPresent = false;

  const setCaller = (present: boolean) => {
    if (present === callerPresent) return;
    callerPresent = present;
    presence.emit(present);
  };
  const hasCaller = (active: Sdk.Room) => active.remoteParticipants.has(CALLER_IDENTITY);

  function wire(active: Sdk.Room) {
    const { RoomEvent, Track, ConnectionState } = sdk;
    active
      .on(RoomEvent.ConnectionStateChanged, (next) => {
        if (next === ConnectionState.Connected) states.emit('connected');
        else if (next === ConnectionState.Connecting) states.emit('connecting');
        else if (
          next === ConnectionState.Reconnecting ||
          next === ConnectionState.SignalReconnecting
        )
          states.emit('reconnecting');
        else if (next === ConnectionState.Disconnected) states.emit('disconnected');
      })
      .on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind !== Track.Kind.Audio) return;
        const element = track.attach();
        element.volume = volume;
        element.style.display = 'none';
        document.body.append(element);
        elements.add(element);
      })
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        for (const element of track.detach()) {
          elements.delete(element);
          element.remove();
        }
      })
      .on(RoomEvent.ParticipantConnected, () => setCaller(hasCaller(active)))
      .on(RoomEvent.ParticipantDisconnected, () => setCaller(hasCaller(active)))
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (topic !== CAPTION_TOPIC || participant?.identity !== CALLER_IDENTITY) return;
        const caption = parseCaption(payload);
        if (caption) captions.emit(caption);
      });
  }

  return {
    provider: 'livekit',
    async connect(grant: RoomGrant) {
      await this.disconnect();
      const next = new sdk.Room({
        adaptiveStream: false,
        dynacast: false,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      room = next;
      wire(next);
      states.emit('connecting');
      try {
        await next.connect(grant.serverUrl, grant.token, { autoSubscribe: true });
        await next.localParticipant.setMicrophoneEnabled(true);
        // Called from the accept gesture, so playback is allowed; a refusal is not fatal.
        await next.startAudio().catch(() => undefined);
      } catch (error) {
        await next.disconnect().catch(() => undefined);
        room = undefined;
        states.emit('disconnected');
        throw error;
      }
      setCaller(hasCaller(next));
    },
    async disconnect() {
      const active = room;
      room = undefined;
      if (!active) return;
      await active.disconnect().catch(() => undefined);
      for (const element of elements) element.remove();
      elements.clear();
      setCaller(false);
      states.emit('disconnected');
    },
    async setMuted(muted) {
      await room?.localParticipant.setMicrophoneEnabled(!muted);
    },
    setVolume(next) {
      volume = Math.min(1, Math.max(0, next));
      for (const element of elements) element.volume = volume;
    },
    async setInputDevice(deviceId) {
      await room?.switchActiveDevice('audioinput', deviceId);
    },
    async setOutputDevice(deviceId) {
      await room?.switchActiveDevice('audiooutput', deviceId);
    },
    onState: (listener) => states.on(listener),
    onCaption: (listener) => captions.on(listener),
    onCallerPresent: (listener) => presence.on(listener),
    levels(): RoomLevels {
      if (!room) return { input: 0, output: 0 };
      let output = 0;
      for (const participant of room.remoteParticipants.values())
        output = Math.max(output, participant.audioLevel);
      return { input: room.localParticipant.audioLevel, output };
    },
  };
}
