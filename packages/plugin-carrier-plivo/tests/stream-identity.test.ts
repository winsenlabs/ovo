import { expect, it } from 'vitest';
import { plivoSerializer } from '../src/serializer.ts';

const start = {
  event: 'start',
  start: {
    callId: 'call-A',
    streamId: 'stream-A',
    mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000 },
  },
};
const frames = {
  media: { sequenceNumber: 1, media: { track: 'inbound', timestamp: 20, payload: 'AQ==' } },
  dtmf: { dtmf: { digit: '5', track: 'inbound' } },
  playedStream: { name: 'confirmation' },
  clearedAudio: {},
  stop: {},
};

it.each(Object.keys(frames) as Array<keyof typeof frames>)(
  'accepts %s only for the established stream',
  (event) => {
    const frame = { event, streamId: 'stream-A', ...frames[event] };
    const session = plivoSerializer.createSession({});
    session.decode(JSON.stringify(start));
    expect(session.decode(JSON.stringify(frame))).toHaveLength(1);
    for (const streamId of ['stream-B', undefined]) {
      expect(() => session.decode(JSON.stringify({ ...frame, streamId }))).toThrow(/streamId/);
    }
    const notStarted = plivoSerializer.createSession({});
    expect(() => notStarted.decode(JSON.stringify(frame))).toThrow(/streamId/);
  },
);

it.each(['outbound', 'invalid', undefined])('refuses non-caller media track %s', (track) => {
  const session = plivoSerializer.createSession({});
  session.decode(JSON.stringify(start));
  expect(() =>
    session.decode(
      JSON.stringify({
        event: 'media',
        streamId: 'stream-A',
        ...frames.media,
        media: { ...frames.media.media, track },
      }),
    ),
  ).toThrow(/track/);
});

it.each(['outbound', 'invalid', undefined])('refuses non-caller DTMF track %s', (track) => {
  const session = plivoSerializer.createSession({});
  session.decode(JSON.stringify(start));
  expect(() =>
    session.decode(
      JSON.stringify({
        event: 'dtmf',
        streamId: 'stream-A',
        dtmf: { digit: '5', track },
      }),
    ),
  ).toThrow(/track/);
});
