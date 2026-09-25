import twilio from 'twilio';

export type TwilioMediaEvent =
  | { type: 'connected'; protocol: string; version: string }
  | {
      type: 'start';
      sequenceNumber: number;
      streamSid: string;
      callSid: string;
      accountSid: string;
      codec: 'audio/x-mulaw';
      sampleRate: 8000;
      channels: 1;
      customParameters: Record<string, string>;
    }
  | {
      type: 'media';
      sequenceNumber: number;
      streamSid: string;
      track: string;
      chunk: number;
      timestampMs: number;
      payload: string;
    }
  | { type: 'mark'; sequenceNumber: number; streamSid: string; name: string }
  | { type: 'clear'; sequenceNumber: number; streamSid: string }
  | { type: 'dtmf'; sequenceNumber: number; streamSid: string; digit: string }
  | {
      type: 'stop';
      sequenceNumber: number;
      streamSid: string;
      callSid: string;
      accountSid: string;
    };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(parsed) || (parsed as number) < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed as number;
}

function customParameters(value: unknown): Record<string, string> {
  const source = object(value ?? {}, 'start.customParameters');
  const output: Record<string, string> = {};
  for (const [key, item] of Object.entries(source))
    output[key] = string(item, `customParameters.${key}`);
  return output;
}

export function parseTwilioMediaMessage(raw: string): TwilioMediaEvent {
  const message = object(JSON.parse(raw) as unknown, 'message');
  const event = string(message.event, 'event');
  if (event === 'connected') {
    return {
      type: 'connected',
      protocol: string(message.protocol, 'protocol'),
      version: string(message.version, 'version'),
    };
  }
  const sequenceNumber = integer(message.sequenceNumber, 'sequenceNumber');
  const streamSid = string(message.streamSid, 'streamSid');
  if (event === 'start') {
    const start = object(message.start, 'start');
    const format = object(start.mediaFormat, 'start.mediaFormat');
    const encoding = string(format.encoding, 'mediaFormat.encoding');
    const sampleRate = integer(format.sampleRate, 'mediaFormat.sampleRate');
    const channels = integer(format.channels, 'mediaFormat.channels');
    if (encoding !== 'audio/x-mulaw' || sampleRate !== 8000 || channels !== 1) {
      throw new Error(`Unsupported Twilio media format ${encoding}/${sampleRate}/${channels}`);
    }
    return {
      type: 'start',
      sequenceNumber,
      streamSid,
      callSid: string(start.callSid, 'start.callSid'),
      accountSid: string(start.accountSid, 'start.accountSid'),
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 1,
      customParameters: customParameters(start.customParameters),
    };
  }
  if (event === 'media') {
    const media = object(message.media, 'media');
    return {
      type: 'media',
      sequenceNumber,
      streamSid,
      track: string(media.track, 'media.track'),
      chunk: integer(media.chunk, 'media.chunk'),
      timestampMs: integer(media.timestamp, 'media.timestamp'),
      payload: string(media.payload, 'media.payload'),
    };
  }
  if (event === 'mark') {
    return {
      type: 'mark',
      sequenceNumber,
      streamSid,
      name: string(object(message.mark, 'mark').name, 'mark.name'),
    };
  }
  if (event === 'clear') return { type: 'clear', sequenceNumber, streamSid };
  if (event === 'dtmf') {
    return {
      type: 'dtmf',
      sequenceNumber,
      streamSid,
      digit: string(object(message.dtmf, 'dtmf').digit, 'dtmf.digit'),
    };
  }
  if (event === 'stop') {
    const stop = object(message.stop, 'stop');
    return {
      type: 'stop',
      sequenceNumber,
      streamSid,
      callSid: string(stop.callSid, 'stop.callSid'),
      accountSid: string(stop.accountSid, 'stop.accountSid'),
    };
  }
  throw new Error(`Unsupported Twilio media event: ${event}`);
}

export function twilioMedia(streamSid: string, mulawPayload: string): string {
  return JSON.stringify({ event: 'media', streamSid, media: { payload: mulawPayload } });
}

export function twilioMark(streamSid: string, name: string): string {
  return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

export function twilioClear(streamSid: string): string {
  return JSON.stringify({ event: 'clear', streamSid });
}

/** Validate against the exact externally visible URL after trusted proxy reconstruction. */
export function validateTwilioSignature(input: {
  authToken: string;
  signature: string | undefined;
  externalUrl: string;
  parameters?: Record<string, string>;
}): boolean {
  if (!input.signature || !input.externalUrl.startsWith('https://')) return false;
  return twilio.validateRequest(
    input.authToken,
    input.signature,
    input.externalUrl,
    input.parameters ?? {},
  );
}
