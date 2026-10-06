// Streams one corpus utterance through a provider the way a call does, and records what came back.
import type { SpeechToText, UsageMeter } from '../../packages/contracts/src/index.ts';
import { adaptSpeechToText } from '../../packages/session-host/src/speech-adapters/stt-format.ts';
import { bytesForMs, silence } from '../../packages/audio/src/index.ts';
import type { Audio } from './audio.ts';
import type { ProviderId, RecordedEvent, Recording } from './types.ts';

export interface TranscribeOptions {
  provider: ProviderId;
  model: string;
  utteranceId: string;
  language: string;
  stt: SpeechToText;
  audio: Audio;
  /** Real-time pacing (20 ms frames every 20 ms). Off only in tests, where the net is scripted. */
  pace?: boolean;
  /** The host commits the turn, as OVO does for Scribe's manual strategy. */
  commits?: boolean;
  /** Silence after the speech before the commit, as OVO's VAD waits (STT-5). */
  commitAfterMs?: number;
  /** How long to wait for the final after the audio ends. */
  settleMs?: number;
  now?: () => number;
}

const FRAME_MS = 20;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One utterance, start to finish: connect (not timed: OVO connects before the caller speaks),
 * stream the speech then trailing silence at real time, commit when the provider needs the host to
 * (Scribe's manual strategy), wait for the final, then finish so usage is reconciled.
 */
export async function transcribe(options: TranscribeOptions): Promise<Recording> {
  const now = options.now ?? Date.now;
  const events: RecordedEvent[] = [];
  const usage: UsageMeter[] = [];
  const controller = new AbortController();
  const stt = adaptSpeechToText(options.stt);
  const recording = (audioEndMs: number, error?: unknown): Recording => ({
    provider: options.provider,
    model: options.model,
    utteranceId: options.utteranceId,
    language: options.language,
    audioEndMs,
    events,
    usage: usage.map(({ unit, quantity, state }) => ({ unit, quantity, state })),
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    recordedAt: new Date().toISOString(),
  });
  let startedAt = now();
  let finalised: () => void = () => undefined;
  const final = new Promise<void>((resolve) => (finalised = resolve));
  let session: Awaited<ReturnType<SpeechToText['start']>>;
  try {
    session = await stt.start({
      sessionId: `bakeoff-${options.utteranceId}`,
      format: options.audio.format,
      language: options.language,
      signal: controller.signal,
      onEvent(event) {
        if (event.type !== 'transcript') return;
        const kind = event.segment.stability === 'final' ? 'final' : 'partial';
        events.push({
          atMs: now() - startedAt,
          kind,
          segmentId: event.segment.segmentId,
          text: event.segment.text,
        });
        if (kind === 'final' && event.segment.text.trim()) finalised();
      },
      onUsage: (meter) => usage.push(meter),
    });
  } catch (error) {
    return recording(0, error);
  }
  const frame = bytesForMs(options.audio.format, FRAME_MS);
  const quiet = silence(options.audio.format, FRAME_MS);
  let audioEndMs = 0;
  try {
    startedAt = now();
    for (let at = 0; at < options.audio.bytes.byteLength; at += frame) {
      await session.write(options.audio.bytes.subarray(at, at + frame));
      if (options.pace !== false) await sleep(FRAME_MS);
    }
    audioEndMs = now() - startedAt;
    const commitAfterMs = options.commitAfterMs ?? 250;
    for (let waited = 0; waited < commitAfterMs; waited += FRAME_MS) {
      await session.write(quiet);
      if (options.pace !== false) await sleep(FRAME_MS);
    }
    if (options.commits) await session.forceEndpoint?.();
    await Promise.race([final, sleep(options.settleMs ?? 4_000)]);
    await Promise.race([session.finish(), sleep(2_000)]);
    return recording(audioEndMs);
  } catch (error) {
    return recording(audioEndMs, error);
  } finally {
    await session.cancel('bake-off done').catch(() => undefined); // swallow-ok: already settled.
    controller.abort();
  }
}
