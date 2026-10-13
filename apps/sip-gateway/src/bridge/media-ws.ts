import { randomUUID } from 'node:crypto';
import {
  SipMediaFrameOutSchema,
  canonicalUrl,
  encodeBase64,
  signRequest,
  type SipMediaFrameOut,
} from '@winsendotai/ovo-sip-carrier-kit';
import WebSocket from 'ws';
import type { BridgeTarget } from './signed-http.ts';

export interface MediaLinkHandlers {
  onFrame(frame: SipMediaFrameOut): void;
  /** A frame the gateway should never send; the link stays up. */
  onProtocolError(reason: string): void;
  /** The socket closed. `byUs` when `close()` started it. */
  onClose(info: { code: number; byUs: boolean }): void;
}

/** The internal ws:// URL for a grant's public wss:// media URL: same path, loopback origin. */
export function internalMediaUrl(
  internalUrl: string,
  mediaUrl: string,
): { url: string; path: string } {
  const media = new URL(mediaUrl);
  if (media.protocol !== 'wss:' || media.search || !media.pathname.startsWith('/carriers/'))
    throw new TypeError('The media URL must be a wss:// carrier URL without a query');
  const base = new URL(internalUrl);
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  return { url: new URL(media.pathname, base).href, path: media.pathname };
}

/**
 * One signed carrier media socket to the media gateway (§5.3). It sends `connected` and `start` on
 * open; the caller owns `seq`/`tsMs` so they stay monotonic across resumes.
 */
export class MediaLink {
  readonly streamId = `st_${randomUUID()}`;
  private closedByUs = false;

  private constructor(private readonly socket: WebSocket) {}

  static async open(input: {
    target: BridgeTarget;
    mediaUrl: string;
    callId: string;
    routeParams: Record<string, string>;
    handlers: MediaLinkHandlers;
    timeoutMs?: number;
  }): Promise<MediaLink> {
    const { url, path } = internalMediaUrl(input.target.internalUrl, input.mediaUrl);
    const headers = await signRequest({
      key: input.target.key,
      method: 'GET',
      externalUrl: canonicalUrl(input.target.publicBaseUrl, path, 'wss'),
      body: new Uint8Array(),
    });
    const socket = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
      handshakeTimeout: input.timeoutMs ?? 5_000,
      maxPayload: 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`media upgrade refused: HTTP ${res.statusCode}`)),
      );
    });
    const link = new MediaLink(socket);
    socket.on('error', () => undefined);
    socket.on('message', (data, isBinary) => {
      if (isBinary) return input.handlers.onProtocolError('binary frame');
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return input.handlers.onProtocolError('frame is not JSON');
      }
      const frame = SipMediaFrameOutSchema.safeParse(parsed);
      if (!frame.success) return input.handlers.onProtocolError('unknown frame');
      input.handlers.onFrame(frame.data);
    });
    socket.on('close', (code) => input.handlers.onClose({ code, byUs: link.closedByUs }));
    link.send({ event: 'connected', v: 1 });
    link.send({
      event: 'start',
      callId: input.callId,
      streamId: link.streamId,
      format: { encoding: 'mulaw', sampleRate: 8000 },
      routeParams: input.routeParams,
    });
    return link;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  private send(frame: Record<string, unknown>): void {
    if (this.open) this.socket.send(JSON.stringify(frame));
  }

  media(seq: number, tsMs: number, payload: Uint8Array): void {
    this.send({ event: 'media', seq, tsMs, payload: encodeBase64(payload) });
  }

  dtmf(digit: string, durationMs?: number): void {
    this.send({ event: 'dtmf', digit, ...(durationMs !== undefined ? { durationMs } : {}) });
  }

  mark(name: string): void {
    this.send({ event: 'mark', name });
  }

  cleared(): void {
    this.send({ event: 'cleared' });
  }

  /** `stop` then a normal close: the call is over on the SIP side. */
  stop(reason: 'caller-hangup' | 'stream-ended'): void {
    this.send({ event: 'stop', reason });
    this.close();
  }

  close(code = 1000): void {
    this.closedByUs = true;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close(code);
  }
}
