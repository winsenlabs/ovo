import {
  CarrierProtocolError,
  MULAW_8K,
  type MediaCodecSession,
  type MediaCommand,
  type MediaSerializer,
  type UpgradeRequest,
} from '@winsendotai/ovo-contracts';
import { parseTwilioMediaMessage, twilioClear, twilioMark, twilioMedia } from './media.ts';
import { validateTwilioSignature } from './signature.ts';

function decode64(value: string): Uint8Array {
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error('Non-canonical base64 audio payload');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encode64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class TwilioMediaCodecSession implements MediaCodecSession {
  private streamSid?: string;
  private started = false;
  private lastSequence = 0;
  constructor(private readonly params: Record<string, string> = {}) {
    this.streamSid = params.streamSid;
  }

  decode(text: string) {
    try {
      const frame = parseTwilioMediaMessage(text);
      if ('sequenceNumber' in frame) {
        if (frame.sequenceNumber <= this.lastSequence)
          throw new Error('Twilio sequence is duplicate or out of order');
        this.lastSequence = frame.sequenceNumber;
      }
      switch (frame.type) {
        case 'connected':
          return [{ type: 'connected' as const }];
        case 'start': {
          if (this.started) throw new Error('Duplicate Twilio start');
          if (this.streamSid && this.streamSid !== frame.streamSid)
            throw new Error('Twilio stream id changed');
          this.streamSid = frame.streamSid;
          this.started = true;
          for (const [canonical, legacy] of [
            ['sid', 'sessionId'],
            ['rt', 'routeToken'],
          ]) {
            if (
              frame.customParameters[canonical!] &&
              frame.customParameters[legacy!] &&
              frame.customParameters[canonical!] !== frame.customParameters[legacy!]
            )
              throw new Error('Conflicting Twilio session route parameters');
          }
          const sid = frame.customParameters.sid ?? frame.customParameters.sessionId;
          const rt = frame.customParameters.rt ?? frame.customParameters.routeToken;
          if (!sid || !rt) throw new Error('Twilio start lacks session route parameters');
          return [
            {
              type: 'start' as const,
              streamId: frame.streamSid,
              carrierCallId: frame.callSid,
              format: MULAW_8K,
              routeParams: { sid, rt },
            },
          ];
        }
        case 'media':
          this.assertStream(frame.streamSid);
          if (frame.track !== 'inbound' && frame.track !== 'inbound_track') return [];
          return [
            {
              type: 'audio' as const,
              seq: frame.sequenceNumber,
              timestampMs: frame.timestampMs,
              payload: decode64(frame.payload),
            },
          ];
        case 'dtmf':
          this.assertStream(frame.streamSid);
          return [{ type: 'dtmf' as const, digit: frame.digit }];
        case 'mark':
          this.assertStream(frame.streamSid);
          return [{ type: 'played' as const, name: frame.name }];
        case 'clear':
          this.assertStream(frame.streamSid);
          return [{ type: 'cleared' as const }];
        case 'stop':
          this.assertStream(frame.streamSid);
          return [{ type: 'stop' as const, reason: 'stream-ended' as const }];
      }
    } catch (error) {
      throw new CarrierProtocolError(error instanceof Error ? error.message : String(error));
    }
  }

  private assertStream(streamSid: string): void {
    if (!this.started || !this.streamSid || streamSid !== this.streamSid)
      throw new Error('Twilio frame does not match the started stream');
  }

  encode(command: MediaCommand): string[] {
    if (!this.streamSid) throw new CarrierProtocolError('Twilio stream id is unavailable');
    if (command.type === 'mark') return [twilioMark(this.streamSid, command.name)];
    if (command.type === 'clear') return [twilioClear(this.streamSid)];
    if (!command.payload.length) return [];
    const frames: string[] = [];
    for (let offset = 0; offset < command.payload.length; offset += 8192)
      frames.push(
        twilioMedia(this.streamSid, encode64(command.payload.subarray(offset, offset + 8192))),
      );
    return frames;
  }
  flush(): string[] {
    return [];
  }
  terminate(): string[] {
    return [];
  }
}

export const twilioMediaSerializer: MediaSerializer = {
  async authenticateUpgrade(req: UpgradeRequest, ctx) {
    const signature = Object.entries(req.headers).find(
      ([name]) => name.toLowerCase() === 'x-twilio-signature',
    )?.[1];
    if (!signature) return { ok: false, status: 403 };
    const binding = await ctx.resolveBinding(ctx.bindingId);
    const url = req.externalUrl;
    if (!url.startsWith('wss://') || new URL(url).search) return { ok: false, status: 403 };
    const signed = (value: string) =>
      validateTwilioSignature({
        authToken: binding.secret,
        signature,
        externalUrl: value,
        parameters: {},
      });
    if (!signed(url) && !signed(url.endsWith('/') ? url : `${url}/`))
      return { ok: false, status: 403 };
    return { ok: true, params: {} };
  },
  createSession(params) {
    return new TwilioMediaCodecSession(params);
  },
};
