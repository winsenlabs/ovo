import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  CarrierProtocolError,
  MULAW_8K,
  type CarrierMediaEvent,
  type MediaCodecSession,
  type MediaCommand,
  type MediaSerializer,
} from '@winsendotai/ovo-contracts';

export const FIXTURE_CARRIER_ID = 'fixture';
export const FIXTURE_SIGNATURE_HEADER = 'x-fixture-signature';

/** base64 HMAC-SHA256 over `payload` — the fixture carrier's (Twilio-shaped) signature scheme. */
export function fixtureSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

export function safeEqual(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new CarrierProtocolError(`fixture carrier: ${what} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new CarrierProtocolError(`fixture carrier: ${what} missing`);
  return value;
}

/** Twilio-shaped frames (connected/start/media/dtmf/mark/stop) plus a fixture `cleared` event. */
class FixtureCodecSession implements MediaCodecSession {
  private streamSid = '';

  decode(raw: string): CarrierMediaEvent[] {
    let frame: Record<string, unknown>;
    try {
      frame = record(JSON.parse(raw), 'frame');
    } catch (error) {
      if (error instanceof CarrierProtocolError) throw error;
      throw new CarrierProtocolError('fixture carrier: frame is not JSON');
    }
    switch (frame.event) {
      case 'connected':
        return [{ type: 'connected' }];
      case 'start': {
        const start = record(frame.start, 'start');
        this.streamSid = text(start.streamSid ?? frame.streamSid, 'start.streamSid');
        const params = record(start.customParameters ?? {}, 'customParameters');
        return [
          {
            type: 'start',
            carrierCallId: text(start.callSid, 'start.callSid'),
            streamId: this.streamSid,
            format: MULAW_8K,
            routeParams: Object.fromEntries(
              Object.entries(params).filter((e): e is [string, string] => typeof e[1] === 'string'),
            ),
          },
        ];
      }
      case 'media': {
        const media = record(frame.media, 'media');
        return [
          {
            type: 'audio',
            seq: Number(frame.sequenceNumber ?? 0),
            timestampMs: Number(media.timestamp ?? 0),
            payload: new Uint8Array(Buffer.from(text(media.payload, 'media.payload'), 'base64')),
          },
        ];
      }
      case 'dtmf':
        return [{ type: 'dtmf', digit: text(record(frame.dtmf, 'dtmf').digit, 'dtmf.digit') }];
      case 'mark':
        return [{ type: 'played', name: text(record(frame.mark, 'mark').name, 'mark.name') }];
      case 'cleared':
        return [{ type: 'cleared' }];
      case 'stop':
        return [{ type: 'stop', reason: 'caller-hangup' }];
      default:
        throw new CarrierProtocolError(`fixture carrier: unknown event ${String(frame.event)}`);
    }
  }

  encode(command: MediaCommand): string[] {
    const streamSid = this.streamSid;
    if (command.type === 'audio')
      return [
        JSON.stringify({ event: 'media', streamSid, media: { payload: base64(command.payload) } }),
      ];
    if (command.type === 'mark')
      return [JSON.stringify({ event: 'mark', streamSid, mark: { name: command.name } })];
    return [JSON.stringify({ event: 'clear', streamSid })];
  }

  flush(): string[] {
    return [];
  }
}

/** Upgrade auth: `x-fixture-signature` = HMAC(binding secret, externalUrl); no query allowed. */
export const fixtureSerializer: MediaSerializer = {
  async authenticateUpgrade(request, ctx) {
    if (request.url.search) return { ok: false, status: 403 };
    const binding = await ctx.resolveBinding(ctx.bindingId);
    const signature = request.headers[FIXTURE_SIGNATURE_HEADER];
    if (!safeEqual(signature, fixtureSignature(binding.secret, request.externalUrl)))
      return { ok: false, status: 401 };
    return { ok: true, params: {} };
  },
  createSession: () => new FixtureCodecSession(),
};

/** Builds the fixture carrier's inbound wire frame for an event (for the fake carrier driver). */
export function fixtureInboundFrame(event: CarrierMediaEvent, streamSid = 'MZfixture'): string {
  switch (event.type) {
    case 'audio':
      return JSON.stringify({
        event: 'media',
        sequenceNumber: String(event.seq),
        streamSid,
        media: { timestamp: String(event.timestampMs), payload: base64(event.payload) },
      });
    case 'played':
      return JSON.stringify({ event: 'mark', streamSid, mark: { name: event.name } });
    case 'dtmf':
      return JSON.stringify({ event: 'dtmf', streamSid, dtmf: { digit: event.digit } });
    case 'start':
      return JSON.stringify({
        event: 'start',
        streamSid: event.streamId,
        start: {
          streamSid: event.streamId,
          callSid: event.carrierCallId,
          customParameters: event.routeParams,
        },
      });
    default:
      return JSON.stringify({ event: event.type, streamSid });
  }
}
