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
import { TokenVerifier, RoomServiceClient } from 'livekit-server-sdk';
import { decodeWav, toneShare } from '../../../packages/audio/src/index.ts';
import { tonePcm16 } from '../../../packages/conformance/src/drivers/audio-gen.ts';
import { mulawToPcm16 } from '../../../packages/audio/src/index.ts';
import type { TestServer } from '../../../packages/plugin-room-livekit/src/testing.ts';

/** The two tones the room scenarios tell apart: the operator's voice and the caller's. */
export const OPERATOR_TONE_HZ = 1_500;
export const CALLER_TONE_HZ = 1_000;
const RATE = 16_000;

/** A tone at least this large a share of a window's energy counts as heard. */
const HEARD_SHARE = 0.5;
/** Windows of this many milliseconds are tested for the tone (mu-law, 8 kHz). */
const WINDOW_MS = 200;

/** Whether the mu-law stream the caller received carries `freq` for at least one whole window. */
export function callerHeardTone(received: Buffer, freq: number): boolean {
  const pcm = mulawToPcm16(new Uint8Array(received));
  const size = (8_000 * WINDOW_MS) / 1_000;
  for (let at = 0; at + size <= pcm.length; at += size)
    if (toneShare(pcm.subarray(at, at + size), 8_000, freq) >= HEARD_SHARE) return true;
  return false;
}

export interface HeadlessOperator {
  /** Whether the room has an audio track from the caller's seat. */
  readonly sawCaller: boolean;
  /** PCM16 (16 kHz) of everything received from other participants, in order. */
  readonly received: () => Int16Array;
  /** Data-channel messages received: topic and parsed JSON when it is. */
  readonly data: { topic: string; from: string; json: unknown }[];
  /** Whether `freq` is in a received window of 200 ms. */
  heard(freq: number): boolean;
  /** Publishes a tone (default the operator's) until `stop`. */
  speak(freq?: number): void;
  stop(): void;
  disconnect(): Promise<void>;
  readonly disconnected: boolean;
}

/**
 * An operator's browser, headless: joins with the token the desk minted, publishes a tone,
 * captures what the caller's seat sends, and keeps the data-channel messages (captions).
 */
export async function joinAsOperator(input: {
  serverUrl: string;
  token: string;
}): Promise<HeadlessOperator> {
  const room = new Room();
  const chunks: Int16Array[] = [];
  const data: HeadlessOperator['data'] = [];
  let sawCaller = false;
  let disconnected = false;
  room.on(RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    sawCaller = true;
    void (async () => {
      try {
        const reader = new AudioStream(track, { sampleRate: RATE, numChannels: 1 }).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          chunks.push(new Int16Array(value.data));
        }
      } catch {
        // swallow-ok: the track ended with the room or the participant.
      }
    })();
  });
  room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(payload).toString('utf8'));
    } catch {
      // swallow-ok: not JSON, only the topic is kept.
    }
    data.push({ topic: topic ?? '', from: participant?.identity ?? '', json });
  });
  room.on(RoomEvent.Disconnected, () => {
    disconnected = true;
  });
  await room.connect(input.serverUrl, input.token, { autoSubscribe: true, dynacast: false });
  const source = new AudioSource(RATE, 1, 1_000);
  await room.localParticipant!.publishTrack(
    LocalAudioTrack.createAudioTrack('mic', source),
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );
  let timer: NodeJS.Timeout | undefined;
  const received = () => {
    const out = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };
  return {
    get sawCaller() {
      return sawCaller;
    },
    get disconnected() {
      return disconnected;
    },
    data,
    received,
    heard(freq) {
      const pcm = received();
      const size = (RATE * WINDOW_MS) / 1_000;
      for (let at = 0; at + size <= pcm.length; at += size)
        if (toneShare(pcm.subarray(at, at + size), RATE, freq) >= HEARD_SHARE) return true;
      return false;
    },
    speak(freq = OPERATOR_TONE_HZ) {
      clearInterval(timer);
      const second = tonePcm16({ freq, ms: 1_000, rate: RATE });
      const frame = RATE / 50;
      let at = 0;
      timer = setInterval(() => {
        const pcm = second.slice(at, at + frame);
        at = (at + frame) % second.length;
        void source.captureFrame(new AudioFrame(pcm, RATE, 1, pcm.length)).catch(() => undefined);
      }, 20);
    },
    stop() {
      clearInterval(timer);
    },
    async disconnect() {
      clearInterval(timer);
      await source.close().catch(() => undefined);
      await room.disconnect().catch(() => undefined);
    },
  };
}

/** The claims in a join token, verified with the server's secret (a forged one rejects). */
export async function tokenClaims(server: TestServer, token: string) {
  const claims = await new TokenVerifier(server.apiKey, server.apiSecret).verify(token);
  return { identity: claims.sub, name: claims.name, grant: claims.video ?? {}, exp: claims.exp };
}

/** The server's own view of its rooms (the API a room reaper and the tests use). */
export function roomsOf(server: TestServer) {
  return new RoomServiceClient(server.url.replace(/^ws/, 'http'), server.apiKey, server.apiSecret);
}

/** Whether a recording track (a WAV, as the api serves it) carries `freq` for a whole window. */
export function wavHasTone(wav: Uint8Array, freq: number): boolean {
  const decoded = decodeWav(wav);
  const pcm = decoded.samples[0]!;
  const size = (decoded.sampleRate * WINDOW_MS) / 1_000;
  for (let at = 0; at + size <= pcm.length; at += size)
    if (toneShare(pcm.subarray(at, at + size), decoded.sampleRate, freq) >= HEARD_SHARE)
      return true;
  return false;
}
