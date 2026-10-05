import type { GatewayToWorkerMessage } from '@winsendotai/ovo-plugin-media';

type HeldMessage = Exclude<GatewayToWorkerMessage, { type: 'session.open' | 'session.close' }>;
type AudioMessage = Extract<GatewayToWorkerMessage, { type: 'media.audio' }>;

/**
 * Caller audio buffered while the voice session is still opening. The native engine's
 * DEFAULT_PRE_STT_BUFFER_MS holds the same span; stt-failure-paths.test.ts pins them together.
 */
export const PRE_SESSION_AUDIO_MS = 10_000;
/** Buffered carrier frames are replayed as chunks of up to this much audio. */
const REPLAY_CHUNK_MS = 200;

/** Gateway events held while the voice session opens, released in order once it has. */
export class PreSessionBuffer {
  private messages: HeldMessage[] = [];
  private audioBytes = 0;
  private readonly bytesPerSecond: number;

  constructor(format: { sampleRate: number; encoding: string }) {
    this.bytesPerSecond = format.sampleRate * (format.encoding === 'pcm_s16le' ? 2 : 1);
  }

  get bytes(): number {
    return this.audioBytes;
  }

  /** Holds one event; false once it would exceed the buffered span, which ends the call. */
  hold(message: HeldMessage): boolean {
    const size = message.type === 'media.audio' ? base64Length(message.payload) : 0;
    // Opening the session waits on the STT provider's handshake, which took 2-5s from an Indian
    // host on the first live call; three seconds of buffer dropped every call.
    const limit = Math.min((this.bytesPerSecond * PRE_SESSION_AUDIO_MS) / 1000, 655_360);
    if (this.audioBytes + size > limit || this.messages.length >= 1_024) return false;
    this.messages.push(message);
    this.audioBytes += size;
    return true;
  }

  /**
   * Empties the buffer. Up to ten seconds arrive at once, so consecutive 20 ms carrier frames are
   * coalesced into larger chunks that stay within the engine's ingress frame limit; byte order
   * and the order of audio against other events are unchanged.
   */
  release(): HeldMessage[] {
    const held = this.messages;
    this.messages = [];
    this.audioBytes = 0;
    const chunkBytes = (this.bytesPerSecond * REPLAY_CHUNK_MS) / 1000;
    const out: HeldMessage[] = [];
    let run: AudioMessage[] = [];
    let runBytes = 0;
    const flush = () => {
      if (run.length) out.push(coalesce(run));
      run = [];
      runBytes = 0;
    };
    for (const message of held) {
      if (message.type !== 'media.audio') {
        flush();
        out.push(message);
        continue;
      }
      run.push(message);
      runBytes += base64Length(message.payload);
      if (runBytes >= chunkBytes) flush();
    }
    flush();
    return out;
  }
}

function base64Length(payload: string): number {
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  return (payload.length * 3) / 4 - padding;
}

/** One audio message carrying a run of consecutive frames, stamped with the first frame's time. */
function coalesce(run: readonly AudioMessage[]): AudioMessage {
  if (run.length === 1) return run[0]!;
  const bytes = Buffer.concat(run.map((item) => Buffer.from(item.payload, 'base64')));
  return { ...run[0]!, payload: bytes.toString('base64') };
}
