import {
  CarrierProtocolError,
  MULAW_8K,
  PCM16_8K,
  PCM16_16K,
  type AudioFormat,
  type CarrierMediaEvent,
  type MediaCodecSession,
  type MediaSerializer,
  type ResolvedBinding,
} from '@winsendotai/ovo-contracts';
import { decodeExtraHeaders } from './extra-headers.ts';
import { header, verifyV3 } from './signature.ts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CarrierProtocolError('Plivo frame must be an object');
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value)
    throw new CarrierProtocolError(`Plivo ${name} is missing`);
  return value;
}

function formatOf(value: Record<string, unknown>): AudioFormat {
  const encoding = String(value.encoding ?? '').toLowerCase();
  const rate = Number(value.sampleRate);
  if ((encoding === 'audio/x-mulaw' || encoding === 'mulaw') && rate === 8000) return MULAW_8K;
  if (
    (encoding === 'audio/x-l16' || encoding === 'l16' || encoding === 'linear16') &&
    rate === 8000
  )
    return PCM16_8K;
  if (
    (encoding === 'audio/x-l16' || encoding === 'l16' || encoding === 'linear16') &&
    rate === 16000
  )
    return PCM16_16K;
  throw new CarrierProtocolError(`Unsupported Plivo media format ${encoding}/${rate}`);
}

function audioBytes(value: unknown): Uint8Array {
  const encoded = string(value, 'media.payload');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
    throw new CarrierProtocolError('Plivo media payload is not canonical base64');
  return Buffer.from(encoded, 'base64');
}

function codec(params: Record<string, string>): MediaCodecSession {
  let streamId: string | undefined;
  let format: AudioFormat = MULAW_8K;
  return {
    decode(text): CarrierMediaEvent[] {
      let frame: Record<string, unknown>;
      try {
        frame = record(JSON.parse(text));
      } catch {
        throw new CarrierProtocolError('Invalid Plivo JSON frame');
      }
      switch (frame.event) {
        case 'start': {
          const start = record(frame.start);
          streamId = string(start.streamId, 'start.streamId');
          format = formatOf(record(start.mediaFormat));
          const extra = frame.extra_headers ?? start.extra_headers ?? '';
          let routeParams: Record<string, string>;
          try {
            routeParams = decodeExtraHeaders(extra as string | Record<string, unknown>);
          } catch {
            throw new CarrierProtocolError('Invalid Plivo extra_headers');
          }
          return [
            {
              type: 'start',
              carrierCallId: string(start.callId, 'start.callId'),
              streamId,
              format,
              routeParams,
            },
          ];
        }
        case 'media': {
          const media = record(frame.media);
          const seq = Number(frame.sequenceNumber);
          const timestampMs = Number(media.timestamp);
          if (
            !Number.isSafeInteger(seq) ||
            seq < 0 ||
            !Number.isFinite(timestampMs) ||
            timestampMs < 0
          )
            throw new CarrierProtocolError('Invalid Plivo media sequence or timestamp');
          return [{ type: 'audio', seq, timestampMs, payload: audioBytes(media.payload) }];
        }
        case 'dtmf':
          return [{ type: 'dtmf', digit: string(record(frame.dtmf).digit, 'dtmf.digit') }];
        case 'playedStream':
          return [{ type: 'played', name: string(frame.name, 'playedStream.name') }];
        case 'clearedAudio':
          return [{ type: 'cleared' }];
        case 'stop':
          return [{ type: 'stop', reason: 'stream-ended' }];
        default:
          throw new CarrierProtocolError(`Unknown Plivo event ${String(frame.event)}`);
      }
    },
    encode(command): string[] {
      if (command.type === 'audio') {
        if (!command.payload.byteLength) return [];
        const contentType = format.encoding === 'mulaw' ? 'audio/x-mulaw' : 'audio/x-l16';
        const frames: string[] = [];
        for (let offset = 0; offset < command.payload.byteLength; offset += 12_000)
          frames.push(
            JSON.stringify({
              event: 'playAudio',
              media: {
                contentType,
                sampleRate: format.sampleRate,
                payload: Buffer.from(command.payload.subarray(offset, offset + 12_000)).toString(
                  'base64',
                ),
              },
            }),
          );
        return frames;
      }
      if (!streamId) throw new CarrierProtocolError('Plivo stream has not started');
      if (command.type === 'mark')
        return [JSON.stringify({ event: 'checkpoint', streamId, name: command.name })];
      return [JSON.stringify({ event: 'clearAudio', streamId })];
    },
    flush: () => [],
    terminate: () => [],
  };
}

export const plivoSerializer: MediaSerializer = {
  async authenticateUpgrade(req, ctx) {
    const binding: ResolvedBinding = await ctx.resolveBinding(ctx.bindingId);
    if (binding.bindingId !== ctx.bindingId) return { ok: false, status: 403 };
    if (req.url.search || !req.externalUrl.startsWith('wss://')) return { ok: false, status: 403 };
    const headers = req.headers;
    if (!header(headers, 'X-Plivo-Signature-V3-Nonce')) return { ok: false, status: 403 };
    const urls = [req.externalUrl, `https://${req.externalUrl.slice(6)}`];
    for (const url of urls)
      if (await verifyV3({ token: binding.secret, url, headers })) return { ok: true, params: {} };
    return { ok: false, status: 403 };
  },
  createSession: codec,
};
