import type { AudioFormat, Clock, Logger, NetPort } from '@winsendotai/ovo-contracts';
import { abortError, delay } from '@winsendotai/ovo-plugin-kit';
import { SYNTHESIS_URL, httpBody, type RumikTtsBinding } from './binding.ts';
import { RumikTtsError, responseError } from './errors.ts';
import { WholeSamples } from './output.ts';

export interface HttpPort {
  net: NetPort;
  apiKey: string;
  binding: Readonly<RumikTtsBinding>;
  clock: Clock;
  logger?: Logger;
}

export interface HttpRender {
  spoken: string;
  voice?: string;
  format: AudioFormat;
  requestId: string;
  signal: AbortSignal;
  /** Rumik accepted the request (a 2xx): from here the characters are billed. */
  accepted(): void;
  audio(bytes: Uint8Array): void;
}

/** 503 "retry shortly": two more attempts, 250 ms then 500 ms. */
const UNAVAILABLE_RETRIES = 2;
const BACKOFF_MS = 250;

const header = (response: Response, name: string) => {
  const value = response.headers.get(name)?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
};

/**
 * `POST /v1/tts` with `audio_format`, read as a binary stream: the path when `transport: 'http'`,
 * and the fallback when the socket cannot be minted or drops before its first byte. Every retry
 * happens before the first byte, because a status arrives before any body: `502 GENERATION_ERROR`
 * is "safe to retry once" and `503` means "retry shortly" (https://docs.rumik.ai/openapi.json).
 */
export async function renderHttp(port: HttpPort, render: HttpRender): Promise<void> {
  const response = await post(port, render);
  render.accepted();
  // `X-Usage-Cost-Nanos` is the reconciled pay-as-you-go charge (0 on unlimited plans), in nano
  // units of the account's currency; logged for reconciliation, never used as a character count.
  port.logger?.info('rumik.tts.http', {
    requestId: render.requestId,
    usageCostNanos: header(response, 'x-usage-cost-nanos'),
    audioDurationMs: header(response, 'x-audio-duration-ms'),
  });
  const samples = new WholeSamples(render.format);
  const reader = response.body!.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      if (render.signal.aborted) throw abortError(render.signal);
      render.audio(samples.cut(value));
    }
  } finally {
    // Leaving early must cancel the body, or Rumik keeps streaming (and holding a slot).
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (samples.partial)
    throw new RumikTtsError('Rumik TTS returned an incomplete PCM sample', false);
}

async function post(port: HttpPort, render: HttpRender): Promise<Response> {
  const init = {
    method: 'POST',
    headers: { authorization: `Bearer ${port.apiKey}`, 'content-type': 'application/json' },
    body: httpBody(port.binding, render.spoken, render.format, render.voice),
    signal: render.signal,
  };
  let generationRetried = false;
  for (let unavailable = 0; ;) {
    let response: Response;
    try {
      response = await port.net.fetch(SYNTHESIS_URL, init);
    } catch (error) {
      if (render.signal.aborted) throw abortError(render.signal);
      // Not retried: a connection that failed after the body went out may already have been
      // rendered and billed, and only 502 and 503 are documented as safe to repeat.
      const reason = error instanceof Error ? error.name : 'Error';
      throw new RumikTtsError(`Rumik TTS request failed (${reason})`, true);
    }
    if (response.ok && response.body) return response;
    const error = await responseError(response, 'TTS');
    if (response.status === 502 && !generationRetried) {
      generationRetried = true;
      continue;
    }
    if (response.status === 503 && unavailable < UNAVAILABLE_RETRIES) {
      await delay(BACKOFF_MS * 2 ** unavailable++, render.signal, port.clock);
      continue;
    }
    // 429 is not retried here: a full concurrency pool frees on the scale of a whole synthesis,
    // and the caller (the speech output) decides whether to try again. It stays retryable.
    throw error;
  }
}
