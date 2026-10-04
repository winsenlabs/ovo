// Synthesis plumbing and the format/identity invariants for the TTS kit.
import {
  MULAW_8K,
  PCM16_16K,
  PCM16_24K,
  PCM16_8K,
  type AudioFormat,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { msForBytes } from '@winsendotai/ovo-audio';
import { createFixtureNet } from '@winsendotai/ovo-plugin-kit';
import { withEgressSentinel } from '../drivers/egress-sentinel.ts';
import { acceleratedClock } from '../drivers/fake-clock.ts';
import { Failures, usageFailures } from './runner.ts';
import type { TtsKitContext } from './tts.ts';

export const CANDIDATES: readonly AudioFormat[] = [
  MULAW_8K,
  { encoding: 'alaw', sampleRate: 8000, channels: 1 },
  PCM16_8K,
  PCM16_16K,
  PCM16_24K,
];

/** No sentence is a handful of bytes long; 40 arbitrary bytes are not speech in any format. */
const MIN_AUDIO_MS = 50;
/** One text spoken in two native formats must last the same time, give or take a tail chunk. */
const DURATION_TOLERANCE = 0.2;

export const label = (format: AudioFormat) => `${format.encoding}@${format.sampleRate}`;

export function scriptsFor(context: TtsKitContext, text: string, format: AudioFormat) {
  if (context.options.scripts) return context.options.scripts(text, format);
  return context.options.template?.({
    format,
    language: context.options.language ?? 'en-US',
    sessionId: 'kit-session',
    turns: [],
    agentTexts: [text],
  });
}

export async function synthesize(
  context: TtsKitContext,
  format: AudioFormat,
  text: string,
  consume: (chunk: Uint8Array, index: number, abort: AbortController) => void = () => undefined,
) {
  const scripts = scriptsFor(context, text, format);
  if (!scripts) throw new Error('no fixture template or scripts were supplied');
  const clock = acceleratedClock(0);
  const net = createFixtureNet(scripts, { clock });
  const usage: UsageMeter[] = [];
  const chunks: Uint8Array[] = [];
  const abort = new AbortController();
  let error: unknown;
  let chunksAfterAbort = 0;
  let endedMs = 0;
  const attempts = await withEgressSentinel(async (sentinel) => {
    const tts = await context.factory({ net, clock });
    let abortedAt = 0;
    try {
      for await (const chunk of tts.synthesize({
        sessionId: 'kit-session',
        text,
        format,
        language: context.options.language ?? 'en-US',
        ...(context.options.voice ? { voice: context.options.voice } : {}),
        signal: abort.signal,
        onUsage: (meter) => usage.push(meter),
      })) {
        if (abort.signal.aborted) chunksAfterAbort += 1;
        chunks.push(chunk);
        consume(chunk, chunks.length - 1, abort);
        if (abort.signal.aborted && !abortedAt) abortedAt = Date.now();
      }
    } catch (caught) {
      error = caught;
    }
    endedMs = abortedAt ? Date.now() - abortedAt : 0;
    return sentinel.attempts;
  });
  return { net, usage, chunks, error, attempts, chunksAfterAbort, endedMs };
}

export function usageOnce(f: Failures, usage: readonly UsageMeter[], when: string): void {
  f.add(...usageFailures(usage, when));
}

export const probe = (context: TtsKitContext): TextToSpeech | Promise<TextToSpeech> =>
  context.factory({ net: createFixtureNet([]), clock: acceleratedClock(0) });

const join = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

/**
 * The bytes really are in the requested format (#F4): whole samples for the encoding, a plausible
 * duration, and — across native formats of one text — the same duration and different bytes. A TTS
 * that returns the same arbitrary buffer for μ-law 8 k and PCM16 24 k no longer passes.
 */
export function formatFailures(
  f: Failures,
  rendered: readonly { format: AudioFormat; chunks: readonly Uint8Array[] }[],
): void {
  const durations: { format: AudioFormat; ms: number }[] = [];
  const bytesByFormat = new Map<string, Uint8Array>();
  for (const { format, chunks } of rendered) {
    const where = label(format);
    const audio = join(chunks);
    const bytes = audio.byteLength;
    if (!f.expect(bytes > 0, `${where}: no audio`)) continue;
    const perSample = format.encoding === 'pcm_s16le' ? 2 : 1;
    if (
      !f.expect(
        bytes % perSample === 0,
        `${where}: ${bytes} bytes is not a whole number of ${format.encoding} samples`,
      )
    )
      continue;
    const samples = bytes / perSample;
    const ms = msForBytes(format, bytes);
    f.expect(
      ms >= MIN_AUDIO_MS,
      `${where}: ${bytes} bytes is ${ms.toFixed(1)} ms (${samples} samples at ${format.sampleRate} Hz), too short to be the requested audio`,
    );
    durations.push({ format, ms });
    bytesByFormat.set(where, audio);
  }
  const longest = durations.reduce((best, entry) => (entry.ms > best.ms ? entry : best), {
    format: rendered[0]?.format ?? MULAW_8K,
    ms: 0,
  });
  for (const entry of durations)
    f.expect(
      longest.ms === 0 || Math.abs(entry.ms - longest.ms) / longest.ms <= DURATION_TOLERANCE,
      `${label(entry.format)}: ${entry.ms.toFixed(1)} ms of audio for the same text that ${label(longest.format)} rendered in ${longest.ms.toFixed(1)} ms`,
    );
  const seen = new Map<string, string>();
  for (const [where, audio] of bytesByFormat) {
    const digest = Buffer.from(audio).toString('base64');
    const clash = seen.get(digest);
    f.expect(
      !clash,
      `${where} and ${clash} returned byte-identical audio, so the requested format was ignored`,
    );
    seen.set(digest, where);
  }
}

/**
 * The cache identity discriminates every input that changes the bytes (#F5). A constant identity
 * would let the speech cache serve μ-law audio for a 24 kHz PCM request.
 */
export function identityFailures(f: Failures, tts: TextToSpeech, configured?: string): void {
  const formats = tts.capabilities.outputFormats ?? [];
  const first = configured ?? 'kit-voice-a';
  const voices = [first, first === 'kit-voice-b' ? 'kit-voice-c' : 'kit-voice-b'];
  const seen = new Map<string, string>();
  for (const format of formats)
    for (const voice of voices) {
      const where = `${label(format)} voice=${voice}`;
      const a = tts.cacheIdentity(format, voice);
      const b = tts.cacheIdentity(format, voice);
      f.expect(
        JSON.stringify(a) === JSON.stringify(b),
        `cacheIdentity changed between calls for ${where}`,
      );
      for (const key of ['provider', 'model', 'voice', 'revision'] as const)
        f.expect(
          typeof a[key] === 'string' && a[key].length > 0,
          `cacheIdentity.${key} is empty for ${where}`,
        );
      const digest = JSON.stringify(a);
      const clash = seen.get(digest);
      f.expect(
        !clash,
        `cacheIdentity is identical for ${clash} and ${where}: the speech cache would serve the wrong audio`,
      );
      seen.set(digest, where);
    }
}
