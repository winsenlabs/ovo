import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AudioFormat, EngineEvent, SpeechEvidence } from '@winsendotai/ovo-contracts';
import type { TelemetryEvent, TelemetryRepository } from '@winsendotai/ovo-plugin-observability';
import { CarrierRoundTrip } from '../src/telemetry-carrier-rtt.ts';
import { WorkerTelemetryRuntime } from '../src/telemetry-runtime.ts';

/**
 * Wave 9 D7, Maya call 10d5ef30: the carrier leg (a US Twilio number to an Indian mobile) was
 * unmeasured; `reply.waits` stopped at the first audio leaving the worker. The opening, turn 10
 * and turn 16 replayed with their real clocks and speech cache sizes. Twilio returns a mark once the
 * audio before it has played: "When that media message's playback is complete, Twilio sends a mark
 * message to your server using the same mark.name", and on a clear it returns the remaining marks
 * at once (https://www.twilio.com/docs/voice/media-streams/websocket-messages, retrieved
 * 2026-10-13).
 */
type Entry = { engine: EngineEvent } | { speechCache: Record<string, unknown> };
const replay = JSON.parse(
  readFileSync(new URL('./fixtures/call5-carrier-replay.json', import.meta.url), 'utf8'),
) as { events: Entry[] };
const ULAW: AudioFormat = { encoding: 'mulaw', sampleRate: 8000, channels: 1 };

async function replayed(mediaFormat?: AudioFormat) {
  const telemetry: TelemetryEvent[] = [];
  const repository = {
    ingest: async (events: readonly TelemetryEvent[]) => {
      telemetry.push(...structuredClone(events));
      return { inserted: events.length, duplicates: 0, conflicts: 0 };
    },
    getCallProjection: async () => undefined,
  } as unknown as TelemetryRepository;
  const runtime = WorkerTelemetryRuntime.fromRepository(repository, {
    controlStore: { appendCallEvent: async () => ({}) as never },
  });
  const session = await runtime.createSession({
    workspaceId: 'workspace-1',
    callId: '10d5ef30',
    agentId: 'maya',
    releaseId: 'release-1',
    language: 'en-IN',
    ...(mediaFormat ? { mediaFormat } : {}),
  });
  for (const entry of replay.events)
    if ('engine' in entry) session.engineEvent(entry.engine);
    else session.audit('speech.cache', entry.speechCache);
  await session.close('caller_hangup');
  await runtime.close();
  return telemetry
    .filter((event) => event.stage === 'reply.waits')
    .map((event) => [event.turnId, (event.payload as Record<string, unknown>).carrierRoundTripMs]);
}

describe('call 10d5ef30 D7: the carrier round trip in reply.waits', () => {
  it('is measured from each idle line’s playback mark, less its audio', async () => {
    // The opening (speech-1, 4648 ms of audio) came back 4926 ms after it was sent: 278 ms. Turn
    // 10's first line (2703 ms) came back after 2973 ms: 270 ms. Its second line was sent while the
    // first still played, so its 10011 ms says nothing about the carrier and is not counted.
    expect(await replayed(ULAW)).toEqual([
      ['opening-1', null],
      ['turn-10', 278],
      ['turn-16', 278],
    ]);
  });

  it('stays null when the media format, and so each line’s length, is unknown', async () => {
    expect(await replayed()).toEqual([
      ['opening-1', null],
      ['turn-10', null],
      ['turn-16', null],
    ]);
  });
});

describe('CarrierRoundTrip', () => {
  const evidence = (segmentId: string, phase: SpeechEvidence['phase'], at: number) =>
    ({ segmentId, phase, at, evidence: 'confirmed' }) as SpeechEvidence;

  it('takes the median of the latest five, and never a flushed or an estimated mark', () => {
    const rtt = new CarrierRoundTrip();
    const line = (id: string, sentAt: number, audioMs: number, ackAt: number) => {
      rtt.speech(evidence(id, 'sent', sentAt));
      rtt.audio(id, audioMs);
      rtt.speech(evidence(id, 'acknowledged', ackAt));
      rtt.speech(evidence(id, 'completed', ackAt));
    };
    line('a', 0, 1000, 1270);
    line('b', 2000, 1000, 3900); // a stalled mark: 900 ms
    line('c', 5000, 1000, 6260);
    expect(rtt.estimateMs).toBe(270);
    // A mark echoed by a clear() comes back before the audio could have played.
    line('d', 7000, 2000, 7100);
    rtt.speech(evidence('e', 'sent', 9000));
    rtt.audio('e', 500);
    rtt.speech({ ...evidence('e', 'acknowledged', 9600), evidence: 'estimated' });
    expect(rtt.estimateMs).toBe(270);
  });
});
