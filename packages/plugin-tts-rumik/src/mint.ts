import type { AudioFormat, Clock, NetPort } from '@winsendotai/ovo-contracts';
import { abortError, readBoundedJson, withDeadline } from '@winsendotai/ovo-plugin-kit';
import { MINT_URL, RUMIK_HOST, mintBody, type RumikTtsBinding } from './binding.ts';
import { RumikTtsError, WS_URL_REJECTED, responseError } from './errors.ts';

/** A minted, not yet redeemed socket: the URL carries the single-use token. */
export interface Lease {
  url: string;
  /** The mint's `request_id`, for logs only. */
  requestId?: string;
  /** Clock time after which the token must not be redeemed. */
  expiresAt: number;
}

export interface MintPort {
  net: NetPort;
  apiKey: string;
  binding: Readonly<RumikTtsBinding>;
  clock: Clock;
}

/** `expires_in` is documented as 300 s; used when the response omits it. */
const DEFAULT_EXPIRES_S = 300;
/** A token this close to expiry is minted again rather than raced against the handshake. */
const EXPIRY_MARGIN_MS = 5_000;

/**
 * The socket to connect to: the minted `ws_url` plus `?token=`. "Always connect to the returned
 * `ws_url`" (https://docs.rumik.ai/streaming), but only on `wss://silk-api.rumik.ai`: a mint answer
 * pointing anywhere else (another host, a port, credentials, plain ws) is refused, so a tampered or
 * misrouted response cannot steer the call's audio and token elsewhere.
 */
export function socketUrl(wsUrl: unknown, token: unknown): string {
  if (typeof wsUrl !== 'string' || typeof token !== 'string' || !token)
    throw new RumikTtsError('Rumik ws-connect returned no ws_url or token', true);
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    // swallow-ok: rethrown below as the typed refusal, without the provider's value.
    url = new URL('invalid:');
  }
  if (
    url.protocol !== 'wss:' ||
    url.hostname !== RUMIK_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  )
    throw new RumikTtsError(
      `Rumik ws-connect returned a ws_url outside wss://${RUMIK_HOST}`,
      false,
      undefined,
      WS_URL_REJECTED,
    );
  url.hash = '';
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * `POST /v1/tts/ws-connect` with `{model, text: "init", audio_format}`. The expiry runs from when
 * the request was sent, not when the answer arrived, so a slow mint never yields a stale token.
 */
export async function mintLease(
  port: MintPort,
  format: AudioFormat,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Lease> {
  const sentAt = port.clock.now();
  const deadline = withDeadline(signal, timeoutMs, 'Rumik ws-connect timed out', port.clock);
  try {
    let response: Response;
    try {
      response = await port.net.fetch(MINT_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${port.apiKey}`, 'content-type': 'application/json' },
        body: mintBody(port.binding, format),
        signal: deadline.signal,
      });
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      const reason = error instanceof Error ? error.name : 'Error';
      throw new RumikTtsError(`Rumik ws-connect failed (${reason})`, true);
    }
    if (!response.ok) throw await responseError(response, 'ws-connect');
    const body = await readBoundedJson(response, 8192);
    const seconds =
      typeof body.expires_in === 'number' && body.expires_in > 0
        ? body.expires_in
        : DEFAULT_EXPIRES_S;
    return {
      url: socketUrl(body.ws_url, body.token),
      ...(typeof body.request_id === 'string' ? { requestId: body.request_id } : {}),
      expiresAt: sentAt + seconds * 1000 - EXPIRY_MARGIN_MS,
    };
  } finally {
    deadline.dispose();
  }
}
