import type { Clock, NetPort, SynthesisInput } from '@winsendotai/ovo-contracts';
import {
  decimal,
  delay,
  readBoundedBytes,
  syntheticRequestId,
  usageOnce,
} from '@winsendotai/ovo-plugin-kit';
import { streamBody, streamUrl, voiceOf, type ElevenLabsTtsBinding } from './binding.ts';
import { ElevenLabsTtsError, SampleAligner, retryableStatus } from './errors.ts';

export interface HttpPort {
  net: NetPort;
  apiKey: string;
  binding: Readonly<ElevenLabsTtsBinding>;
  clock: Clock;
}

/** Two retries (250 ms, 500 ms) before the first byte, as the POC did for 429/409/5xx. */
const RETRIES = 2;
const BACKOFF_MS = 250;

/**
 * `POST /v1/text-to-speech/{voice}/stream`: the fallback when the socket is unavailable, and the
 * whole path when a binding chooses `transport: 'http'`. Retries happen only before any audio.
 */
export async function* streamHttp(
  port: HttpPort,
  input: SynthesisInput,
  requestNumber: number,
): AsyncIterable<Uint8Array> {
  const usage = usageOnce(input.onUsage);
  const startedAt = port.clock.now();
  let requestId = syntheticRequestId('elevenlabs', input.sessionId, requestNumber);
  let billed: number | undefined;
  try {
    const response = await post(port, input);
    // `request-id` and `character-cost` are the names the API reference introduction gives
    // (`CHARACTER_COST_SOURCE` in testing.ts, retrieved 2026-10-06); some SDK guides say `x-character-count`, so it
    // is read as a fallback. Neither is confirmed on a live call yet: a missing header leaves the
    // synthetic id and the estimated count in place.
    requestId = response.headers.get('request-id') || requestId;
    const counted =
      response.headers.get('character-cost') ?? response.headers.get('x-character-count');
    if (counted !== null && /^\d+$/.test(counted.trim())) billed = Number(counted.trim());
    const aligner = new SampleAligner(input.format);
    const reader = response.body!.getReader();
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        input.signal.throwIfAborted();
        const whole = aligner.push(value);
        if (whole) yield whole;
      }
    } finally {
      // A consumer that stops early must cancel the body, or the provider keeps streaming.
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (aligner.pending)
      throw new ElevenLabsTtsError('ElevenLabs TTS returned an incomplete PCM sample', false);
  } finally {
    usage.emit({
      provider: 'elevenlabs',
      operation: 'tts',
      unit: 'characters',
      quantity: decimal(billed ?? [...input.text].length),
      state: billed === undefined ? 'estimated' : 'reconciled',
      requestId,
      elapsedMs: Math.max(0, port.clock.now() - startedAt),
    });
  }
}

async function post(port: HttpPort, input: SynthesisInput): Promise<Response> {
  const url = streamUrl(port.binding, voiceOf(port.binding, input.voice), input.format);
  const body = streamBody(port.binding, input.text);
  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await port.net.fetch(url, {
        method: 'POST',
        headers: { 'xi-api-key': port.apiKey, 'content-type': 'application/json' },
        body,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted || attempt >= RETRIES) throw error;
      await delay(BACKOFF_MS * 2 ** attempt, input.signal, port.clock);
      continue;
    }
    if (response.ok && response.body) return response;
    const error = await failure(response);
    if (!error.retryable || attempt >= RETRIES) throw error;
    await delay(BACKOFF_MS * 2 ** attempt, input.signal, port.clock);
  }
}

/** Error bodies look like `{detail: {status, message}}` (UNCONFIRMED); only `status` is kept. */
async function failure(response: Response): Promise<ElevenLabsTtsError> {
  let status = '';
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(await readBoundedBytes(response, 4096)),
    );
    const detail = (parsed as { detail?: { status?: unknown } } | null)?.detail;
    if (typeof detail?.status === 'string') status = `: ${detail.status}`;
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  return new ElevenLabsTtsError(
    `ElevenLabs TTS failed with HTTP ${response.status}${status}`,
    retryableStatus(response.status),
    response.status,
  );
}
