import { describe, expect, it } from 'vitest';
import type { EngineEvent, MediaDuplex, VoiceSessionEngine } from '@winsendotai/ovo-contracts';
import {
  checkEngine,
  createReferenceEngine,
  runCheck,
  type EnginePorts,
  type EngineUnderTest,
  type KitFailure,
} from '../src/index.ts';

const messages = (failures: KitFailure[]) => failures.map((f) => f.message).join('\n');

/** The reference engine with its event stream rewritten on the way to subscribers. */
function withEvents(
  ports: EnginePorts,
  map: (event: EngineEvent) => EngineEvent | undefined,
): EngineUnderTest {
  const under = createReferenceEngine(ports);
  const engine: VoiceSessionEngine = {
    start: () => under.engine.start(),
    dispose: (reason, options) => under.engine.dispose(reason, options),
    get ended() {
      return under.engine.ended;
    },
    get ingressStats() {
      return under.engine.ingressStats;
    },
    subscribe: (listener) =>
      under.engine.subscribe((event) => {
        const mapped = map(event);
        if (mapped) listener(mapped);
      }),
  };
  return { ...under, engine };
}

const dropPhases = (phases: readonly string[]) => (event: EngineEvent) =>
  event.type === 'speech' && phases.includes(event.evidence.phase) ? undefined : event;

describe('checkEngine rejects engines that drop telemetry', () => {
  it('flags an engine that never forwards provider usage (F12)', async () => {
    const failures = await checkEngine(
      (ports) => createReferenceEngine({ ...ports, usage: () => undefined }),
      {},
      { only: ['FAQ answers'] },
    );
    expect(messages(failures)).toMatch(/never reached the engine's UsageSink/);
    expect(messages(failures)).toMatch(/the engine spoke but reported no tts usage/);
  }, 60_000);

  it('flags a speech stream whose sequence and epoch are not monotonic (F13)', async () => {
    const constant = await checkEngine(
      (ports) =>
        withEvents(ports, (event) =>
          event.type === 'speech'
            ? { ...event, evidence: { ...event.evidence, sequence: 1 } }
            : event,
        ),
      {},
      { only: ['variables reach'] },
    );
    expect(messages(constant)).toMatch(/sequence 1 does not follow 1/);
    const backwards = await checkEngine(
      (ports) =>
        withEvents(ports, (event) =>
          event.type === 'speech'
            ? { ...event, evidence: { ...event.evidence, epoch: 9 - event.evidence.epoch } }
            : event,
        ),
      {},
      { only: ['variables reach'] },
    );
    expect(messages(backwards)).toMatch(/speech evidence epoch went back from 8 to 7/);
  }, 60_000);

  it("flags a dropped 'queued' phase (F14)", async () => {
    const failures = await checkEngine(
      (ports) => withEvents(ports, dropPhases(['queued'])),
      {},
      { only: ['FAQ answers'] },
    );
    expect(messages(failures)).toMatch(/no 'queued' phase/);
  }, 60_000);

  it("flags confirmed playback with the 'acknowledged' phase dropped (F14)", async () => {
    const failures = await checkEngine(
      (ports) => withEvents(ports, dropPhases(['acknowledged'])),
      {},
      { only: ["a 'carrier-played' carrier confirms"] },
    );
    expect(messages(failures)).toMatch(/claims confirmed playback without an 'acknowledged' phase/);
  }, 60_000);

  it("flags a suppressed 'started' phase used to evade receipt ordering (F17)", async () => {
    const failures = await checkEngine(
      (ports) =>
        withEvents(
          { ...ports, behavior: { ...ports.behavior, onPlayback: undefined } },
          dropPhases(['started']),
        ),
      {},
      { only: ['an interrupted confirmation'] },
    );
    expect(messages(failures)).toMatch(/was dispatched before the receipt for/);
  }, 60_000);
});

/** The fake carrier's duplex with one method replaced. */
const patchedMedia = (media: MediaDuplex, patch: Partial<MediaDuplex>): MediaDuplex =>
  Object.create(
    Object.getPrototypeOf(media) as object,
    Object.getOwnPropertyDescriptors({ ...media, ...patch }),
  ) as MediaDuplex;

describe('checkEngine rejects broken playback evidence and clear ordering', () => {
  it('flags audio that reaches the carrier after media.clear (F15)', async () => {
    const failures = await checkEngine(
      (ports) => {
        // A writer that keeps a chunk in flight and lets it land after the barge-in clear.
        let tail: Uint8Array | undefined;
        return createReferenceEngine({
          ...ports,
          media: patchedMedia(ports.media, {
            async sendAudio(bytes: Uint8Array, signal?: AbortSignal) {
              tail = bytes;
              await ports.media.sendAudio(bytes, signal);
            },
            async clear(signal?: AbortSignal) {
              await ports.media.clear(signal);
              const late = tail;
              if (late)
                setTimeout(() => void ports.media.sendAudio(late).catch(() => undefined), 50);
            },
          }),
        });
      },
      {},
      { only: ['no audio reaches the carrier after an interrupt'] },
    );
    expect(messages(failures)).toMatch(/audio writes reached the carrier after media\.clear/);
  }, 60_000);

  it("flags an engine that confirms 'carrier-processed' playback (F16)", async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          media: patchedMedia(ports.media, { playbackEvidence: 'carrier-played' }),
        }),
      {},
      { only: ["a 'carrier-processed' carrier only estimates"] },
    );
    expect(messages(failures)).toMatch(/the receipt evidence is 'confirmed', expected 'estimated'/);
  }, 60_000);

  it("flags an engine that ignores the 'weak-playback-evidence' acknowledgement (F16)", async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          session: { ...ports.session, acknowledgements: [] },
        }),
      {},
      { only: ["the 'weak-playback-evidence' acknowledgement"] },
    );
    expect(messages(failures)).toMatch(/the receipt evidence is 'estimated', expected 'confirmed'/);
  }, 60_000);

  it('accepts an engine that omits the optional AbortSignal on media.mark (F24)', async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          media: patchedMedia(ports.media, { mark: (name: string) => ports.media.mark(name) }),
        }),
      {},
      { only: ['barge-in clears media'] },
    );
    expect(messages(failures)).toBe('');
  }, 60_000);

  it('still flags an engine whose barge-in never clears the carrier (F24)', async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          media: patchedMedia(ports.media, { clear: async () => undefined }),
        }),
      {},
      { only: ['barge-in clears media'] },
    );
    expect(messages(failures)).toMatch(/media was never cleared|the barged-in segment was/);
  }, 60_000);
});

describe('checkEngine rejects an engine that ignores the session surface', () => {
  it('flags a missing maxCallSeconds watchdog (F18)', async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          session: { ...ports.session, maxCallSeconds: 9999 },
        }),
      {},
      { only: ['the session watchdog'] },
    );
    expect(messages(failures)).toMatch(/ended with nothing instead of max_duration/);
  }, 60_000);

  it('flags an engine that never subscribes to answeredBy (F18)', async () => {
    const failures = await checkEngine(
      (ports) =>
        createReferenceEngine({
          ...ports,
          media: patchedMedia(ports.media, { onAnsweredBy: undefined }),
        }),
      {},
      { only: ['answeredBy from the carrier'] },
    );
    expect(messages(failures)).toMatch(/timed out waiting for the voicemail event/);
  }, 60_000);

  it('flags an engine that reports no ingress stats or transcripts (F18)', async () => {
    const failures = await checkEngine(
      (ports) =>
        withEvents({ ...ports, transcripts: undefined }, (event) =>
          event.type === 'timing' ? undefined : event,
        ),
      {},
      { only: ['ingress stats, user transcripts'] },
    );
    expect(messages(failures)).toMatch(/transcripts observer never received an event/);
    expect(messages(failures)).toMatch(/emitted no timing events for a spoken turn/);
  }, 60_000);
});

describe('checkEngine requires declared capabilities, and the runner cancels abandoned work', () => {
  it('flags an engine that declares no EngineCapabilities (F18)', async () => {
    const failures = await checkEngine(
      (ports) => {
        const under = createReferenceEngine(ports);
        return { engine: under.engine, speech: under.speech };
      },
      {},
      { only: ['declares coherent EngineCapabilities'] },
    );
    expect(messages(failures)).toMatch(/did not declare EngineCapabilities/);
  }, 60_000);

  it('flags capabilities that contradict what the engine did (F18)', async () => {
    const failures = await checkEngine(
      (ports) => ({
        ...createReferenceEngine(ports),
        capabilities: {
          turnDetection: ['telepathy' as 'stt'],
          bargeIn: true,
          dtmf: true,
          confirmedPlayback: true,
          ownsProviders: true as unknown as false,
          formats: [],
          consumesTurnDetector: true,
        },
      }),
      {},
      { only: ['declares coherent EngineCapabilities'] },
    );
    expect(messages(failures)).toMatch(/unknown strategy 'telepathy'/);
    expect(messages(failures)).toMatch(/ownsProviders must be false/);
    expect(messages(failures)).toMatch(/formats must list the carrier formats/);
  }, 60_000);

  it('aborts the work a timed-out check left behind (F26)', async () => {
    let aborted = false;
    const failures = await runCheck<Record<string, never>>(
      {
        name: 'slow check',
        timeoutMs: 20,
        run: (_context, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve([]);
            });
          }),
      },
      () => ({}),
    );
    expect(failures[0]?.message).toMatch(/slow check timed out after 20 ms/);
    expect(aborted).toBe(true);
  });
});
