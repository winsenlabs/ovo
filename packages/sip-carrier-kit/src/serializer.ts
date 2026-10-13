import {
  CarrierProtocolError,
  MULAW_8K,
  type CarrierMediaEvent,
  type MediaCodecSession,
  type MediaCommand,
  type MediaSerializer,
  type SipRequestVerifier,
} from '@winsendotai/ovo-contracts';
import { decodeBase64, encodeBase64 } from './bytes.ts';
import { SipMediaFrameInSchema } from './wire.ts';

/** The media gateway refuses larger carrier audio frames; the sip-gateway sends 160 bytes. */
export const SIP_MAX_AUDIO_FRAME = 8192;
/** Downstream audio is split into frames of at most this many bytes. */
export const SIP_MAX_DOWNSTREAM_FRAME = 32 * 1024;

const STOP_REASONS = new Set(['caller-hangup', 'stream-ended']);

function frameOf(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CarrierProtocolError('SIP media frame is not JSON');
  }
  const parsed = SipMediaFrameInSchema.safeParse(value);
  if (!parsed.success)
    throw new CarrierProtocolError(
      `Invalid SIP media frame: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  return parsed.data;
}

/**
 * One codec session per media socket. Every frame after `start` belongs to that stream: the
 * sip-gateway opens a new socket (and stream id) for every resume, so a second `start` is an error.
 */
export class SipMediaCodecSession implements MediaCodecSession {
  private started = false;
  private stopped = false;
  private lastSeq = 0;

  decode(text: string): CarrierMediaEvent[] {
    const frame = frameOf(text);
    if (this.stopped) throw new CarrierProtocolError('SIP media frame after stop');
    if (frame.event === 'connected') {
      if (this.started) throw new CarrierProtocolError('SIP connected after start');
      return [{ type: 'connected' }];
    }
    if (frame.event === 'start') {
      if (this.started) throw new CarrierProtocolError('Duplicate SIP start');
      const { sid, rt } = frame.routeParams;
      if (!sid || !rt) throw new CarrierProtocolError('SIP start lacks session route parameters');
      this.started = true;
      return [
        {
          type: 'start',
          carrierCallId: frame.callId,
          streamId: frame.streamId,
          format: MULAW_8K,
          routeParams: frame.routeParams,
        },
      ];
    }
    if (!this.started) throw new CarrierProtocolError(`SIP ${frame.event} before start`);
    switch (frame.event) {
      case 'media': {
        if (frame.seq <= this.lastSeq)
          throw new CarrierProtocolError('SIP media seq is duplicate or out of order');
        this.lastSeq = frame.seq;
        let payload: Uint8Array;
        try {
          payload = decodeBase64(frame.payload);
        } catch (error) {
          throw new CarrierProtocolError(`SIP media payload: ${(error as Error).message}`);
        }
        if (!payload.byteLength || payload.byteLength > SIP_MAX_AUDIO_FRAME)
          throw new CarrierProtocolError(`SIP media payload is ${payload.byteLength} bytes`);
        return [{ type: 'audio', seq: frame.seq, timestampMs: frame.tsMs, payload }];
      }
      case 'dtmf':
        return [
          {
            type: 'dtmf',
            digit: frame.digit,
            ...(frame.durationMs !== undefined ? { durationMs: frame.durationMs } : {}),
          },
        ];
      case 'mark':
        return [{ type: 'played', name: frame.name }];
      case 'cleared':
        return [{ type: 'cleared' }];
      case 'stop':
        this.stopped = true;
        return [
          {
            type: 'stop',
            reason: STOP_REASONS.has(frame.reason)
              ? (frame.reason as 'caller-hangup' | 'stream-ended')
              : 'unknown',
          },
        ];
    }
  }

  encode(command: MediaCommand): string[] {
    if (command.type === 'mark') return [JSON.stringify({ event: 'mark', name: command.name })];
    if (command.type === 'clear') return [JSON.stringify({ event: 'clear' })];
    const frames: string[] = [];
    for (let offset = 0; offset < command.payload.byteLength; offset += SIP_MAX_DOWNSTREAM_FRAME)
      frames.push(
        JSON.stringify({
          event: 'media',
          payload: encodeBase64(
            command.payload.subarray(offset, offset + SIP_MAX_DOWNSTREAM_FRAME),
          ),
        }),
      );
    return frames;
  }

  /** The sip-gateway reframes into 20 ms packets itself, so nothing is held back here. */
  flush(): string[] {
    return [];
  }

  terminate(): string[] {
    return [JSON.stringify({ event: 'terminate' })];
  }
}

/**
 * The media upgrade is authenticated by its ovo-sip/1 signature through `Cap.sipTrunkVerifier`; the
 * route parameters travel in `start`, so a query-bearing URL is refused.
 */
export function createSipMediaSerializer(input: {
  verifier: () => SipRequestVerifier | undefined;
}): MediaSerializer {
  return {
    async authenticateUpgrade(req) {
      const verifier = input.verifier();
      if (!verifier) return { ok: false, status: 403 };
      if (!req.externalUrl.startsWith('wss://') || req.url.search || /[?#]/.test(req.externalUrl))
        return { ok: false, status: 403 };
      const ok = await verifier.verify({
        method: 'GET',
        externalUrl: req.externalUrl,
        headers: req.headers,
        body: new Uint8Array(0),
      });
      return ok ? { ok: true, params: {} } : { ok: false, status: 401 };
    },
    createSession() {
      return new SipMediaCodecSession();
    },
  };
}
