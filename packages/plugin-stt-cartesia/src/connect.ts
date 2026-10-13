import {
  MULAW_8K,
  PCM16_16K,
  PCM16_8K,
  sameFormat,
  type AudioFormat,
  type Clock,
  type NetPort,
  type WebSocketLike,
} from '@winsendotai/ovo-contracts';
import type { CartesiaSttSession } from './session.ts';
import { CartesiaSttError } from './wire.ts';

/** Native input formats of both endpoints: raw `pcm_mulaw` 8 kHz and `pcm_s16le` 8/16 kHz. */
export const INK_FORMATS: readonly AudioFormat[] = Object.freeze([MULAW_8K, PCM16_8K, PCM16_16K]);
/** Frames as both references recommend ("small chunks, e.g. 100 ms"), never above 100 ms. */
export const INK_FRAME_MS = Object.freeze({ min: 20, max: 100, preferred: 100 });

export function assertInkFormat(format: AudioFormat): void {
  if (!INK_FORMATS.some((native) => sameFormat(native, format)))
    throw new TypeError('Cartesia STT takes 8 kHz μ-law or 8/16 kHz PCM16 only');
}

/**
 * Opens one provider socket with the `X-API-Key` header and resolves once it is open. A socket
 * still not open at the deadline is abandoned as a retryable failure, which the host's STT
 * recovery may reconnect from.
 */
export async function connectSession<T extends CartesiaSttSession>(
  net: NetPort,
  url: string,
  key: string,
  clock: Pick<Clock, 'setTimeout'>,
  timeoutMs: number,
  create: (socket: WebSocketLike) => T,
): Promise<T> {
  const session = create(net.websocket(url, { headers: { 'X-API-Key': key } }));
  const stop = clock.setTimeout(
    () =>
      session.abandon(
        new CartesiaSttError(
          `Cartesia STT not open within ${timeoutMs} ms`,
          'connect-timeout',
          true,
        ),
      ),
    timeoutMs,
  );
  try {
    await session.ready;
  } finally {
    stop();
  }
  return session;
}
