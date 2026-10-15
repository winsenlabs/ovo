import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import { bytesToPcm16, createReframer, pcm16ToBytes } from '@winsendotai/ovo-audio';
import {
  describeMediaRoom,
  fakeMediaRoom,
  type MediaRoomUnderTest,
  type RoomDataMessage,
  type RoomParticipantClient,
  type RoomTokenClaims,
} from '@winsendotai/ovo-conformance';
import { PCM16_16K, type AudioFormat } from '@winsendotai/ovo-contracts';
import { afterAll, describe, it } from 'vitest';
import { LiveKitRoomProvider } from '../src/provider.ts';
import { ROOM_FORMAT } from '../src/seat.ts';
import type { TestServer } from '../src/testing.ts';
import { verifyToken } from '../src/tokens.ts';

const RATE = ROOM_FORMAT.sampleRate;

/** What a verified LiveKit token says, in the kit's provider-neutral terms. */
async function claimsOf(server: TestServer, token: string): Promise<RoomTokenClaims> {
  const claims = await verifyToken({ key: server.apiKey, secret: server.apiSecret }, token);
  const video = claims.video ?? {};
  return {
    room: String(video.room),
    identity: String(claims.sub),
    ...(claims.name ? { name: claims.name } : {}),
    issuedAtMs: (claims.nbf ?? 0) * 1000,
    expiresAtMs: (claims.exp ?? 0) * 1000,
    canJoin: video.roomJoin === true,
    canPublish: video.canPublish === true,
    canSubscribe: video.canSubscribe === true,
    canPublishData: video.canPublishData === true,
    // Verified claims carry the sources as their names ("microphone"), whatever the SDK types say.
    ...(video.canPublishSources
      ? { publishSources: video.canPublishSources as unknown as string[] }
      : {}),
    roomAdmin: video.roomAdmin === true,
    roomCreate: video.roomCreate === true,
    roomList: video.roomList === true,
    hidden: video.hidden === true,
  };
}

/**
 * A real rtc-node participant behind the kit's `RoomParticipantClient`. It refuses what its token
 * forbids on the client side (as a browser SDK would), while the server enforces the same rights;
 * `provider.test.ts` proves the server does so on its own.
 */
async function connect(
  server: TestServer,
  input: { token: string; room: string; format: AudioFormat },
): Promise<RoomParticipantClient> {
  const claims = await claimsOf(server, input.token);
  // A token names its room and the server puts the holder there; asking for another is a refusal.
  if (claims.room !== input.room) throw new Error('the token is for another room');
  const room = new Room();
  const audioListeners = new Set<(frame: Uint8Array, from: string) => void>();
  const dataListeners = new Set<(message: RoomDataMessage) => void>();
  const disconnectListeners = new Set<(reason: string) => void>();
  room.on(RoomEvent.TrackSubscribed, (track, _pub, remote) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    const down = createReframer(ROOM_FORMAT, input.format, 20);
    void (async () => {
      try {
        const reader = new AudioStream(track, {
          sampleRate: RATE,
          numChannels: 1,
          frameSizeMs: 20,
        }).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          for (const frame of down.push(pcm16ToBytes(value.data)))
            for (const listener of audioListeners) listener(frame, remote.identity);
        }
      } catch {
        // swallow-ok: the track went away with the room or the participant.
      }
    })();
  });
  room.on(RoomEvent.DataReceived, (payload, from, _kind, topic) => {
    for (const listener of dataListeners)
      listener({
        topic: topic ?? '',
        payload: new Uint8Array(payload),
        from: from?.identity ?? '',
      });
  });
  room.on(RoomEvent.Disconnected, (reason) => {
    for (const listener of disconnectListeners) listener(String(reason));
  });
  await room.connect(server.url, input.token, { autoSubscribe: true, dynacast: false });
  let source: AudioSource | undefined;
  if (claims.canPublish) {
    source = new AudioSource(RATE, 1, 500);
    await room.localParticipant!.publishTrack(
      LocalAudioTrack.createAudioTrack('mic', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
  }
  // A browser is "in" the room once it hears who is already there: wait for the audio tracks
  // that exist now to be subscribed, so a tone played right after connect is not lost to setup.
  const present = [...room.remoteParticipants.values()].flatMap((remote) =>
    [...remote.trackPublications.values()].filter((pub) => pub.kind === TrackKind.KIND_AUDIO),
  );
  for (let waited = 0; waited < 3_000 && !present.every((pub) => pub.subscribed); waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const up = createReframer(input.format, ROOM_FORMAT, 20);
  return {
    identity: claims.identity,
    get connected() {
      return room.isConnected;
    },
    sendAudio(frame) {
      if (!source) throw new Error('this token cannot publish audio');
      for (const bytes of up.push(frame)) {
        const pcm = bytesToPcm16(bytes);
        void source.captureFrame(new AudioFrame(pcm, RATE, 1, pcm.length)).catch(() => undefined);
      }
    },
    onAudio(listener) {
      audioListeners.add(listener);
      return () => void audioListeners.delete(listener);
    },
    sendData(topic, payload) {
      if (!claims.canPublishData) throw new Error('this token cannot publish data');
      void room
        .localParticipant!.publishData(payload, { reliable: true, topic })
        .catch(() => undefined);
    },
    onData(listener) {
      dataListeners.add(listener);
      return () => void dataListeners.delete(listener);
    },
    onDisconnected(listener) {
      disconnectListeners.add(listener);
      return () => void disconnectListeners.delete(listener);
    },
    async close() {
      await source?.close().catch(() => undefined);
      await room.disconnect().catch(() => undefined);
    },
  };
}

/** The real plugin against a real server, as the media-room kit wants it. */
function livekitUnderTest(server: TestServer): MediaRoomUnderTest {
  return {
    room: new LiveKitRoomProvider(server.config()),
    claimsOf: (token) => claimsOf(server, token),
    connect: (input) => connect(server, input),
    close: async () => undefined,
  };
}

import { serverOrSkip } from './support/server.ts';

// media-room@1 over the reference fake, always, and over the real plugin against a real LiveKit
// server when one is available (OVO_LIVEKIT_TEST_URL/_API_KEY/_API_SECRET, or livekit-server on
// PATH); the real plugin also runs it for a wideband seat, since the format is the lease's.
describeMediaRoom('fakeMediaRoom (reference)', () => fakeMediaRoom());

const server = await serverOrSkip('conformance.test.ts');
afterAll(() => server?.stop());

// Real-time audio over a real WebRTC session, driven by the kit's wall-clock send loops. On a busy
// shared build machine an event-loop stall turns a 1.2 s tone into a gappy one and the kit rightly
// calls it not heard. The delivery window is widened (default 3 s) so a stall delays a check
// instead of failing it, and a failed check is still retried twice as a safety net; a genuine
// fault fails every attempt.
if (server) {
  describe('real server', { retry: 2 }, () => {
    describeMediaRoom('LiveKit room plugin, mu-law 8 kHz', () => livekitUnderTest(server), {
      deliveryMs: 10_000,
    });
    describeMediaRoom('LiveKit room plugin, PCM16 16 kHz', () => livekitUnderTest(server), {
      format: PCM16_16K,
      deliveryMs: 10_000,
    });
  });
} else it.skip('LiveKit room plugin conformance: no LiveKit server available', () => undefined);
