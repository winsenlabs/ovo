import {
  CarrierProtocolError,
  PCM16_8K,
  PCM16_16K,
  type CarrierMediaEvent,
  type MediaCodecSession,
  type MediaCommand,
  type MediaSerializer,
} from '@winsendotai/ovo-contracts';
import { ExotelChunker } from './chunker.ts';
import { allowedAddress, validBasic } from './signature.ts';

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CarrierProtocolError(`Exotel ${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value)
    throw new CarrierProtocolError(`Exotel ${label} must be a nonempty string`);
  return value;
}

function number(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0)
    throw new CarrierProtocolError(`Exotel ${label} must be a nonnegative integer`);
  return parsed;
}

function pcm(value: unknown): Uint8Array {
  const encoded = string(value, 'media.payload');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new CarrierProtocolError('Exotel media.payload is not base64');
  const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  if (bytes.byteLength % 2 !== 0)
    throw new CarrierProtocolError('Exotel PCM16 payload has odd bytes');
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class ExotelCodecSession implements MediaCodecSession {
  private streamId: string | undefined;
  private readonly chunks = new ExotelChunker();

  constructor(private readonly queryParams: Record<string, string>) {}

  decode(text: string): CarrierMediaEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CarrierProtocolError('Exotel frame is not JSON');
    }
    const frame = object(parsed, 'frame');
    switch (frame.event) {
      case 'connected':
        return [{ type: 'connected' }];
      case 'start': {
        const start = object(frame.start, 'start');
        const format = object(start.media_format, 'start.media_format');
        if (format.encoding !== 'raw')
          throw new CarrierProtocolError('Exotel media encoding is not raw PCM16');
        if (format.sample_rate !== '8000' && format.sample_rate !== '16000')
          throw new CarrierProtocolError('Unsupported Exotel sample rate');
        this.streamId = string(frame.stream_sid, 'stream_sid');
        if (start.stream_sid && start.stream_sid !== this.streamId)
          throw new CarrierProtocolError('Exotel start.stream_sid differs from stream_sid');
        const custom = start.custom_parameters
          ? object(start.custom_parameters, 'custom_parameters')
          : {};
        const routeParams: Record<string, string> = {};
        for (const key of ['sid', 'rt']) {
          const selected = custom[key] ?? this.queryParams[key];
          if (typeof selected === 'string' && selected) routeParams[key] = selected;
        }
        return [
          {
            type: 'start',
            carrierCallId: string(start.call_sid, 'start.call_sid'),
            streamId: this.streamId,
            format: format.sample_rate === '8000' ? PCM16_8K : PCM16_16K,
            routeParams,
          },
        ];
      }
      case 'media': {
        this.assertStream(frame);
        const media = object(frame.media, 'media');
        return [
          {
            type: 'audio',
            seq: number(frame.sequence_number, 'sequence_number'),
            timestampMs: number(media.timestamp, 'media.timestamp'),
            payload: pcm(media.payload),
          },
        ];
      }
      case 'dtmf': {
        this.assertStream(frame);
        const dtmf = object(frame.dtmf, 'dtmf');
        const digit = string(dtmf.digit, 'dtmf.digit');
        if (!/^[0-9*#ABCD]$/.test(digit))
          throw new CarrierProtocolError('Invalid Exotel DTMF digit');
        return [
          {
            type: 'dtmf',
            digit,
            ...(dtmf.duration !== undefined
              ? { durationMs: number(dtmf.duration, 'dtmf.duration') }
              : {}),
          },
        ];
      }
      case 'mark': {
        this.assertStream(frame);
        return [{ type: 'played', name: string(object(frame.mark, 'mark').name, 'mark.name') }];
      }
      case 'stop': {
        this.assertStream(frame);
        const reason = object(frame.stop, 'stop').reason;
        if (reason !== 'stopped' && reason !== 'callended')
          throw new CarrierProtocolError('Unknown Exotel stop.reason');
        return [
          { type: 'stop', reason: reason === 'callended' ? 'caller-hangup' : 'stream-ended' },
        ];
      }
      default:
        throw new CarrierProtocolError(`Unknown Exotel event ${String(frame.event)}`);
    }
  }

  encode(command: MediaCommand): string[] {
    const stream_sid = this.started();
    switch (command.type) {
      case 'audio':
        if (command.payload.byteLength % 2 !== 0)
          throw new CarrierProtocolError('Exotel outbound PCM16 has odd bytes');
        return this.chunks
          .push(command.payload)
          .map((payload) =>
            JSON.stringify({ event: 'media', stream_sid, media: { payload: base64(payload) } }),
          );
      case 'mark':
        return [
          ...this.flush(),
          JSON.stringify({ event: 'mark', stream_sid, mark: { name: command.name } }),
        ];
      case 'clear':
        this.chunks.clear();
        return [JSON.stringify({ event: 'clear', stream_sid })];
    }
  }

  flush(): string[] {
    const stream_sid = this.started();
    return this.chunks
      .flush()
      .map((payload) =>
        JSON.stringify({ event: 'media', stream_sid, media: { payload: base64(payload) } }),
      );
  }

  /** Exotel documents no outbound stop frame; the gateway closes the WebSocket. */
  terminate(): string[] {
    return [];
  }

  private started(): string {
    if (!this.streamId) throw new CarrierProtocolError('Exotel stream has not started');
    return this.streamId;
  }

  private assertStream(frame: Record<string, unknown>): void {
    if (!this.streamId || frame.stream_sid !== this.streamId)
      throw new CarrierProtocolError('Exotel frame stream_sid does not match start');
  }
}

export const exotelMediaSerializer: MediaSerializer = {
  async authenticateUpgrade(req, ctx) {
    try {
      const binding = await ctx.resolveBinding(ctx.bindingId);
      if (!allowedAddress(req, binding)) return { ok: false, status: 401 };
      const sid = req.url.searchParams.get('sid');
      const rt = req.url.searchParams.get('rt');
      const token = req.url.searchParams.get('t');
      const validToken =
        !!sid &&
        !!rt &&
        !!token &&
        ctx.verifyUrlSecret({
          purpose: 'media',
          bindingId: ctx.bindingId,
          requestId: sid,
          token,
        });
      if (!validBasic(req, binding) && !validToken) return { ok: false, status: 401 };
      return { ok: true, params: Object.fromEntries(req.url.searchParams) };
    } catch {
      return { ok: false, status: 401 };
    }
  },
  createSession(params) {
    return new ExotelCodecSession(params);
  },
};
