import {
  MULAW_8K,
  type CarrierMediaEvent,
  type FixtureTemplate,
  type NetFixtureScript,
} from '@winsendotai/ovo-contracts';

const SOURCE = 'https://www.twilio.com/docs/voice/api/call-resource';
const SID = 'AC00000000000000000000000000000000';
const callUrl = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls.json`;
const callSid = 'CA00000000000000000000000000000000';
const updateUrl = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Calls/${callSid}.json`;

/** Strict REST scripts; FixtureNet never contacts Twilio. */
export const fixtures: Record<string, NetFixtureScript[]> = {
  'twilio.dial': [
    {
      host: 'api.twilio.com',
      source: SOURCE,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: callUrl,
          body: 'form',
          reply: { status: 201, body: JSON.stringify({ sid: callSid, status: 'queued' }) },
        },
      ],
    },
  ],
  'twilio.reconcile': [
    {
      host: 'api.twilio.com',
      source: SOURCE,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'GET',
          url: updateUrl,
          reply: { status: 200, body: JSON.stringify({ sid: callSid, status: 'busy' }) },
        },
      ],
    },
  ],
  'twilio.hangup': [
    {
      host: 'api.twilio.com',
      source: SOURCE,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: updateUrl,
          body: 'form',
          where: { Status: 'completed' },
          reply: { status: 200, body: JSON.stringify({ sid: callSid, status: 'completed' }) },
        },
      ],
    },
  ],
  'twilio.handoff': [
    {
      host: 'api.twilio.com',
      source: SOURCE,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: updateUrl,
          body: 'form',
          reply: { status: 200, body: JSON.stringify({ sid: callSid, status: 'in-progress' }) },
        },
      ],
    },
  ],
};

/** Fixture calls use documented carrier frames; no Twilio REST script is needed. */
export const fixtureTemplates: Record<string, FixtureTemplate> = {
  '@winsendotai/ovo-carrier-twilio': () => [],
};

export interface TwilioFixtureInboundInput {
  sessionId: string;
  routeToken: string;
  callSid?: string;
  accountSid?: string;
  streamSid?: string;
  audio?: Uint8Array;
  digit?: string;
}

/** Build real Twilio wire frames for a host-local fixture call. */
export function twilioFixtureInboundFrames(input: TwilioFixtureInboundInput): string[] {
  const call = input.callSid ?? callSid;
  const account = input.accountSid ?? SID;
  const stream = input.streamSid ?? 'MZ00000000000000000000000000000000';
  const frames: Record<string, unknown>[] = [
    { event: 'connected', protocol: 'Call', version: '1.0.0' },
    {
      event: 'start',
      sequenceNumber: '1',
      streamSid: stream,
      start: {
        streamSid: stream,
        accountSid: account,
        callSid: call,
        tracks: ['inbound'],
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        customParameters: { sid: input.sessionId, rt: input.routeToken },
      },
    },
  ];
  let sequence = 2;
  if (input.audio?.length) {
    let binary = '';
    for (const byte of input.audio) binary += String.fromCharCode(byte);
    frames.push({
      event: 'media',
      sequenceNumber: String(sequence++),
      streamSid: stream,
      media: { track: 'inbound', chunk: '1', timestamp: '0', payload: btoa(binary) },
    });
  }
  if (input.digit)
    frames.push({
      event: 'dtmf',
      sequenceNumber: String(sequence++),
      streamSid: stream,
      dtmf: { track: 'inbound_track', digit: input.digit },
    });
  frames.push({
    event: 'stop',
    sequenceNumber: String(sequence),
    streamSid: stream,
    stop: { accountSid: account, callSid: call },
  });
  return frames.map((frame) => JSON.stringify(frame));
}

export const twilioFixtureFormat = MULAW_8K;

/** Encode one carrier-neutral event as a documented Twilio inbound frame. */
export function twilioFixtureInboundFrame(
  event: CarrierMediaEvent,
  streamSid = 'MZ00000000000000000000000000000000',
): string {
  const frame: Record<string, unknown> = (() => {
    switch (event.type) {
      case 'connected':
        return { event: 'connected', protocol: 'Call', version: '1.0.0' };
      case 'start':
        return {
          event: 'start',
          sequenceNumber: '1',
          streamSid: event.streamId,
          start: {
            streamSid: event.streamId,
            callSid: event.carrierCallId,
            accountSid: SID,
            tracks: ['inbound'],
            mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
            customParameters: event.routeParams,
          },
        };
      case 'audio': {
        let binary = '';
        for (const byte of event.payload) binary += String.fromCharCode(byte);
        return {
          event: 'media',
          sequenceNumber: String(event.seq),
          streamSid,
          media: {
            track: 'inbound',
            chunk: '1',
            timestamp: String(event.timestampMs),
            payload: btoa(binary),
          },
        };
      }
      case 'dtmf':
        return {
          event: 'dtmf',
          sequenceNumber: '2',
          streamSid,
          dtmf: { track: 'inbound_track', digit: event.digit },
        };
      case 'played':
        return { event: 'mark', sequenceNumber: '2', streamSid, mark: { name: event.name } };
      case 'cleared':
        return { event: 'clear', sequenceNumber: '2', streamSid };
      case 'stop':
        return {
          event: 'stop',
          sequenceNumber: '2',
          streamSid,
          stop: { accountSid: SID, callSid },
        };
    }
  })();
  return JSON.stringify(frame);
}

/** Per-call encoder keeps stream/call identity without mutable process-wide state. */
export function createTwilioFixtureFrameEncoder(): (event: CarrierMediaEvent) => string {
  let streamSid = 'MZ00000000000000000000000000000000';
  let carrierCallId = callSid;
  let sequence = 1;
  return (event) => {
    if (event.type === 'start') {
      streamSid = event.streamId;
      carrierCallId = event.carrierCallId;
      sequence = 1;
    }
    if (event.type === 'audio') sequence = Math.max(sequence + 1, event.seq);
    else if (event.type !== 'connected' && event.type !== 'start') sequence++;
    const wire = JSON.parse(twilioFixtureInboundFrame(event, streamSid)) as Record<string, unknown>;
    if ('sequenceNumber' in wire) wire.sequenceNumber = String(sequence);
    if (event.type === 'stop') wire.stop = { accountSid: SID, callSid: carrierCallId };
    return JSON.stringify(wire);
  };
}
