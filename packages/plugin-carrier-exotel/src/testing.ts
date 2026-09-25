import {
  PCM16_8K,
  type CarrierMediaEvent,
  type FixtureTemplate,
  type NetFixtureScript,
} from '@winsendotai/ovo-contracts';

const SOURCE = 'https://developer.exotel.com/docs/voice-v1/api-reference/connect-to-flow';
const SID = 'exotel-account';
const CALL = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
const base = `https://api.in.exotel.com/v1/Accounts/${SID}/Calls`;

/** Strict host-local REST replay. The response is copied from the published flow example. */
export const fixtures: Record<string, NetFixtureScript[]> = {
  'exotel.dial': [
    {
      host: 'api.in.exotel.com',
      source: SOURCE,
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: `${base}/connect.json`,
          body: 'form',
          reply: {
            status: 200,
            body: JSON.stringify({
              Call: {
                Sid: CALL,
                ParentCallSid: null,
                DateCreated: '2017-03-03 12:30:24',
                DateUpdated: '2017-03-03 12:30:27',
                AccountSid: SID,
                To: null,
                From: '09876543210',
                PhoneNumberSid: '0XXXXXX4890',
                Status: 'in-progress',
                StartTime: '2017-03-03 12:30:27',
                EndTime: null,
                Duration: null,
                Price: null,
                Direction: 'outbound-api',
                AnsweredBy: null,
                Uri: `/v1/Accounts/${SID}/Calls.json/${CALL}`,
                RecordingUrl: null,
              },
            }),
          },
        },
      ],
    },
  ],
  'exotel.reconcile': [
    {
      host: 'api.in.exotel.com',
      source: 'https://developer.exotel.com/docs/voice-v1/api-reference/call-details',
      retrieved: '2026-09-22',
      steps: [
        {
          expect: 'http',
          method: 'GET',
          url: `${base}/${CALL}.json`,
          reply: {
            status: 200,
            body: JSON.stringify({ Call: { Sid: CALL, Status: 'completed' } }),
          },
        },
      ],
    },
  ],
};

export const fixtureTemplates: Record<string, FixtureTemplate> = {
  '@winsendotai/ovo-carrier-exotel': () => [],
};

export interface ExotelFixtureInboundInput {
  sessionId: string;
  routeToken: string;
  callSid?: string;
  streamSid?: string;
  audio?: Uint8Array;
  digit?: string;
}

/** Documented snake_case frames for an in-process fixture call. */
export function exotelFixtureInboundFrames(input: ExotelFixtureInboundInput): string[] {
  const stream = input.streamSid ?? 'stream-fixture-1';
  const call = input.callSid ?? CALL;
  const frames: Record<string, unknown>[] = [
    { event: 'connected' },
    {
      event: 'start',
      sequence_number: 1,
      stream_sid: stream,
      start: {
        stream_sid: stream,
        call_sid: call,
        account_sid: SID,
        from: '+919876543210',
        to: '+911234567890',
        custom_parameters: { sid: input.sessionId, rt: input.routeToken },
        media_format: { encoding: 'raw', sample_rate: '8000', bit_rate: '128' },
      },
    },
  ];
  let sequence = 2;
  if (input.audio?.byteLength) {
    let binary = '';
    for (const byte of input.audio) binary += String.fromCharCode(byte);
    frames.push({
      event: 'media',
      sequence_number: sequence++,
      stream_sid: stream,
      media: { chunk: 1, timestamp: '0', payload: btoa(binary) },
    });
  }
  if (input.digit)
    frames.push({
      event: 'dtmf',
      sequence_number: sequence++,
      stream_sid: stream,
      dtmf: { digit: input.digit, duration: '200' },
    });
  frames.push({
    event: 'stop',
    sequence_number: sequence,
    stream_sid: stream,
    stop: { call_sid: call, account_sid: SID, reason: 'stopped' },
  });
  return frames.map((frame) => JSON.stringify(frame));
}

export const exotelFixtureFormat = PCM16_8K;

/** One documented inbound wire frame for gateway fixture replay. */
export function exotelFixtureInboundFrame(event: CarrierMediaEvent, streamId?: string): string {
  const stream = event.type === 'start' ? event.streamId : (streamId ?? 'stream-fixture-1');
  switch (event.type) {
    case 'connected':
      return JSON.stringify({ event: 'connected' });
    case 'start':
      return exotelFixtureInboundFrames({
        sessionId: event.routeParams.sid ?? 'session-fixture',
        routeToken: event.routeParams.rt ?? 'route-fixture',
        callSid: event.carrierCallId,
        streamSid: stream,
      })[1]!;
    case 'audio': {
      let binary = '';
      for (const byte of event.payload) binary += String.fromCharCode(byte);
      return JSON.stringify({
        event: 'media',
        sequence_number: event.seq,
        stream_sid: stream,
        media: { chunk: event.seq, timestamp: String(event.timestampMs), payload: btoa(binary) },
      });
    }
    case 'dtmf':
      return JSON.stringify({
        event: 'dtmf',
        stream_sid: stream,
        dtmf: { digit: event.digit, duration: String(event.durationMs ?? 200) },
      });
    case 'played':
      return JSON.stringify({ event: 'mark', stream_sid: stream, mark: { name: event.name } });
    case 'stop':
      return JSON.stringify({
        event: 'stop',
        stream_sid: stream,
        stop: { reason: event.reason === 'caller-hangup' ? 'callended' : 'stopped' },
      });
    case 'cleared':
      return JSON.stringify({ event: 'clear', stream_sid: stream });
  }
}

export function createExotelFixtureFrameEncoder(): (event: CarrierMediaEvent) => string {
  let streamId = 'stream-fixture-1';
  return (event) => {
    if (event.type === 'start') streamId = event.streamId;
    return exotelFixtureInboundFrame(event, streamId);
  };
}
