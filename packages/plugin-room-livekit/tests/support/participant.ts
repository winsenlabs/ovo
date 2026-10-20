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
import { toneShare } from '@winsendotai/ovo-audio';

const RATE = 16_000;
const FRAME = 320;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(check: () => boolean, ms = 8_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/**
 * A headless browser stand-in: a real rtc-node participant that joins with a minted token,
 * publishes a pure tone, and records what it hears from the others.
 */
export class HeadlessParticipant {
  readonly heard = new Map<string, Int16Array[]>();
  readonly data: { topic: string; text: string; from?: string }[] = [];
  private stopTone?: () => void;

  private constructor(readonly room: Room) {}

  static async join(url: string, token: string): Promise<HeadlessParticipant> {
    const room = new Room();
    const participant = new HeadlessParticipant(room);
    room.on(RoomEvent.TrackSubscribed, (track, _pub, remote) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const frames: Int16Array[] = [];
      participant.heard.set(remote.identity, frames);
      void (async () => {
        const reader = new AudioStream(track, {
          sampleRate: RATE,
          numChannels: 1,
          frameSizeMs: 20,
        }).getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            frames.push(value.data.slice());
          }
        } catch {
          // swallow-ok: the track went away with the room.
        }
      })();
    });
    room.on(RoomEvent.DataReceived, (payload, from, _kind, topic) =>
      participant.data.push({
        topic: topic ?? '',
        text: Buffer.from(payload).toString(),
        from: from?.identity,
      }),
    );
    await room.connect(url, token, { autoSubscribe: true, dynacast: false });
    return participant;
  }

  /** Publishes a sine at `freq` in real time until `stop()` or disconnect. */
  async publishTone(freq: number): Promise<void> {
    const source = new AudioSource(RATE, 1, 500);
    await this.room.localParticipant!.publishTrack(
      LocalAudioTrack.createAudioTrack('tone', source),
      new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
    );
    let sent = 0;
    const started = performance.now();
    let live = true;
    this.stopTone = () => (live = false);
    void (async () => {
      while (live) {
        const due = started + (sent * 20) / 1;
        if (performance.now() >= due) {
          const data = new Int16Array(FRAME);
          for (let i = 0; i < FRAME; i += 1)
            data[i] = Math.round(
              10_000 * Math.sin((2 * Math.PI * freq * (sent * FRAME + i)) / RATE),
            );
          sent += 1;
          await source.captureFrame(new AudioFrame(data, RATE, 1, FRAME)).catch(() => undefined);
        } else await sleep(2);
      }
      await source.close().catch(() => undefined);
    })();
  }

  stopPublishing(): void {
    this.stopTone?.();
  }

  /** The concatenated audio heard from `identity`, skipping the first `skipMs` of start-up. */
  audioFrom(identity: string, skipMs = 400): Int16Array {
    const frames = this.heard.get(identity) ?? [];
    const kept = frames.slice(Math.round(skipMs / 20));
    const out = new Int16Array(kept.length * FRAME);
    kept.forEach((frame, i) => out.set(frame, i * FRAME));
    return out;
  }

  /** The share of the audio heard from `identity` that sits at `freq`. */
  share(identity: string, freq: number): number {
    return toneShare(this.audioFrom(identity), RATE, freq);
  }

  async disconnect(): Promise<void> {
    this.stopPublishing();
    await this.room.disconnect().catch(() => undefined);
  }
}
