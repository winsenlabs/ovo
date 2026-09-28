import type { CarrierMediaEvent, NetFixtureScript, NetPort } from '@winsendotai/ovo-contracts';
import { plivoControl } from './control.ts';
import { plivoIngress } from './plugin.ts';
import { encodeExtraHeaders } from './extra-headers.ts';

/** Per-call Plivo wire encoder for D1's selected-carrier fixture replay. */
export function createPlivoFixtureFrameEncoder(): (event: CarrierMediaEvent) => string {
  let streamId: string | undefined;
  let sequence = 0;
  return (event) => {
    if (event.type === 'start') {
      streamId = event.streamId;
      sequence = 1;
      return JSON.stringify({
        event: 'start',
        sequenceNumber: sequence,
        start: {
          callId: event.carrierCallId,
          streamId,
          accountId: 'MAXFIXTURE00000000000',
          tracks: ['inbound'],
          mediaFormat: {
            encoding: event.format.encoding === 'mulaw' ? 'audio/x-mulaw' : 'audio/x-l16',
            sampleRate: event.format.sampleRate,
          },
        },
        extra_headers: encodeExtraHeaders(event.routeParams),
      });
    }
    if (!streamId) throw new Error('Plivo fixture stream has not started');
    sequence = Math.max(sequence + 1, event.type === 'audio' ? event.seq : 0);
    switch (event.type) {
      case 'audio':
        return JSON.stringify({
          event: 'media',
          sequenceNumber: sequence,
          streamId,
          media: {
            track: 'inbound',
            timestamp: String(event.timestampMs),
            chunk: sequence - 1,
            payload: Buffer.from(event.payload).toString('base64'),
          },
        });
      case 'dtmf':
        return JSON.stringify({
          event: 'dtmf',
          sequenceNumber: sequence,
          streamId,
          dtmf: { track: 'inbound', digit: event.digit },
        });
      case 'played':
        return JSON.stringify({
          event: 'playedStream',
          sequenceNumber: sequence,
          streamId,
          name: event.name,
        });
      case 'cleared':
        return JSON.stringify({ event: 'clearedAudio', sequenceNumber: sequence, streamId });
      case 'stop':
        return JSON.stringify({ event: 'stop', sequenceNumber: sequence, streamId });
      case 'connected':
        throw new Error('Plivo has no connected wire frame');
    }
  };
}

export const PLIVO_FIXTURE_HOST = 'api.plivo.com';
export const plivoForTest = (net: NetPort) => ({
  control: plivoControl(net),
  ingress: plivoIngress,
});
export const plugins = [];
/** A documented request_uuid-only dial response for catalog fixture consumers. */
export const fixtures: Record<string, NetFixtureScript[]> = {
  '@winsendotai/ovo-carrier-plivo': [
    {
      host: PLIVO_FIXTURE_HOST,
      source: 'https://www.plivo.com/docs/voice/api/calls',
      retrieved: '2026-09-26',
      steps: [
        {
          expect: 'http',
          method: 'POST',
          url: 'https://api.plivo.com/v1/Account/AUTH1/Call/',
          headers: { authorization: /^Basic / },
          body: 'json',
          reply: { status: 201, body: '{"request_uuid":"request-1"}' },
        },
      ],
    },
  ],
};
// FixtureTemplateInput has speech turns, not carrier call controls.
export const fixtureTemplates = {};
