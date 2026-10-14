// Batch (pre-recorded) transcription of a call's utterances, a second opinion for the gold
// references: batch models see whole sentences and both directions of context. The utterances go
// up as one compressed file, each separated by a second of silence, and the words come back to
// their utterance by timestamp.
import type { NetPort } from '../../../contracts/src/index.ts';
import { writeWav, type Pcm } from './wav.ts';

export const GAP_MS = 1_000;

export interface BatchUtterance {
  id: string;
  pcm: Pcm;
}

export interface BatchWord {
  text: string;
  startMs: number;
  endMs: number;
}

export interface BatchRecording {
  config: string;
  call: string;
  model: string;
  recordedAt: string;
  /** Length of the file sent, the billed audio. */
  audioMs: number;
  /** The language the provider detected for the file. */
  language?: string;
  utterances: { id: string; text: string }[];
  error?: string;
}

/** The utterances joined by `GAP_MS` of silence, and where each starts in the joined file. */
export function compress(utterances: readonly BatchUtterance[]): {
  pcm: Pcm;
  offsetsMs: number[];
  lengthsMs: number[];
} {
  const rate = utterances[0]?.pcm.sampleRate ?? 8000;
  const gap = (rate * GAP_MS) / 1000;
  const total = utterances.reduce((sum, u) => sum + u.pcm.samples.length + gap, 0);
  const samples = new Int16Array(total);
  const offsetsMs: number[] = [];
  const lengthsMs: number[] = [];
  let at = 0;
  for (const utterance of utterances) {
    if (utterance.pcm.sampleRate !== rate) throw new Error('utterances differ in sample rate');
    offsetsMs.push((at / rate) * 1000);
    lengthsMs.push((utterance.pcm.samples.length / rate) * 1000);
    samples.set(utterance.pcm.samples, at);
    at += utterance.pcm.samples.length + gap;
  }
  return { pcm: { sampleRate: rate, samples }, offsetsMs, lengthsMs };
}

/** Each word goes to the utterance its start falls in (half a gap of slack either side). */
export function wordsByUtterance(
  words: readonly BatchWord[],
  offsetsMs: readonly number[],
  lengthsMs: readonly number[],
): string[] {
  const texts = offsetsMs.map(() => [] as string[]);
  for (const word of words) {
    const index = offsetsMs.findIndex(
      (offset, i) =>
        word.startMs >= offset - GAP_MS / 2 && word.startMs < offset + lengthsMs[i]! + GAP_MS / 2,
    );
    if (index >= 0) texts[index]!.push(word.text.trim());
  }
  return texts.map((text) => text.filter(Boolean).join(' '));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A multipart/form-data body built by hand, so it does not depend on which fetch sends it. */
export function multipart(
  fields: readonly [string, string][],
  upload: { name: string; file: Uint8Array },
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const boundary = `ovo-eval-${Math.random().toString(36).slice(2)}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = fields.map(([name, value]) =>
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  parts.push(
    encoder.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${upload.name}"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    upload.file,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  );
  const body = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok)
    throw new Error(`${what} failed: HTTP ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/**
 * ElevenLabs Scribe batch (`POST /v1/speech-to-text`, multipart: `model_id`, `file`, optional
 * `language_code`, `timestamps_granularity`, `tag_audio_events`; the response's `words[]` have
 * `text`, `start`/`end` in seconds and `type`). https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * (retrieved 2026-10-14).
 */
export async function scribeBatch(
  net: NetPort,
  key: string,
  pcm: Pcm,
  options: {
    model: 'scribe_v2' | 'scribe_v1';
    languageCode?: string;
    keyterms?: readonly string[];
  },
): Promise<{ language?: string; words: BatchWord[] }> {
  const fields: [string, string][] = [
    ['model_id', options.model],
    ['timestamps_granularity', 'word'],
    ['tag_audio_events', 'false'],
    ...(options.languageCode ? [['language_code', options.languageCode] as [string, string]] : []),
    ...(options.keyterms ?? []).map((term) => ['keyterms', term] as [string, string]),
  ];
  const { body, contentType } = multipart(fields, { name: 'file', file: writeWav(pcm) });
  const result = await json(
    await net.fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': contentType },
      body,
    }),
    'Scribe batch',
  );
  const words = (Array.isArray(result.words) ? result.words : []) as Record<string, unknown>[];
  return {
    language: typeof result.language_code === 'string' ? result.language_code : undefined,
    words: words
      .filter((word) => word.type === undefined || word.type === 'word')
      .map((word) => ({
        text: String(word.text ?? ''),
        startMs: Number(word.start) * 1000,
        endMs: Number(word.end) * 1000,
      })),
  };
}

/**
 * AssemblyAI pre-recorded: upload (`POST /v2/upload`), submit (`POST /v2/transcript` with
 * `audio_url`, `speech_models`, `language_detection`; code-switching per
 * https://www.assemblyai.com/docs/pre-recorded-audio/code-switching), then poll until
 * `completed`. Words carry `start`/`end` in ms. Reference:
 * https://www.assemblyai.com/docs/api-reference/transcripts/submit (retrieved 2026-10-14).
 */
export async function assemblyAiBatch(
  net: NetPort,
  key: string,
  pcm: Pcm,
  options: { languageCodes?: readonly string[]; pollMs?: number } = {},
): Promise<{ language?: string; words: BatchWord[] }> {
  const base = 'https://api.assemblyai.com/v2';
  const headers = { authorization: key };
  const upload = await json(
    await net.fetch(`${base}/upload`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      body: writeWav(pcm),
    }),
    'AssemblyAI upload',
  );
  const submitted = await json(
    await net.fetch(`${base}/transcript`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        audio_url: upload.upload_url,
        speech_models: ['universal-3-5-pro', 'universal-2'],
        ...(options.languageCodes
          ? { language_codes: options.languageCodes }
          : { language_detection: true }),
      }),
    }),
    'AssemblyAI submit',
  );
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await json(
      await net.fetch(`${base}/transcript/${String(submitted.id)}`, { headers }),
      'AssemblyAI poll',
    );
    if (result.status === 'error')
      throw new Error(`AssemblyAI transcript error: ${String(result.error)}`);
    if (result.status === 'completed') {
      const words = (Array.isArray(result.words) ? result.words : []) as Record<string, unknown>[];
      return {
        language: typeof result.language_code === 'string' ? result.language_code : undefined,
        words: words.map((word) => ({
          text: String(word.text ?? ''),
          startMs: Number(word.start),
          endMs: Number(word.end),
        })),
      };
    }
    await sleep(options.pollMs ?? 2_000);
  }
  throw new Error('AssemblyAI transcript did not complete in time');
}
