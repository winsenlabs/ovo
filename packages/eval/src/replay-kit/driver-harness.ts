// Promoted in Wave 13 from packages/plugin-voice/tests/turn-harness.ts so the eval harness and the plugin tests share it.
import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  SpeechOutput,
  TurnDecision,
  TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import { VoiceEventBus } from '../../../plugin-voice/src/engine/events.ts';
import { TurnLatency } from '../../../plugin-voice/src/engine/latency.ts';
import { SpeechEventProjector } from '../../../plugin-voice/src/engine/speech-events.ts';
import { TurnDriver } from '../../../plugin-voice/src/engine/turn-driver.ts';
import { BoundedSpeechScheduler } from '../../../plugin-voice/src/scheduler.ts';
import type { SpeechTimingSink } from '../../../plugin-voice/src/speech/timing.ts';

/** The conformance kit's FakeClock, structurally (this support file may not import the kit). */
export interface TestClock extends Clock {
  advanceAsync(ms: number): Promise<void>;
}

const session: SessionInput = {
  mode: 'agent',
  language: 'en-IN',
  inputEnabled: true,
  variables: {},
  maxCallSeconds: 600,
  acknowledgements: [],
};

/** Resolves after `ms` of fake time, or at once when `signal` aborts. */
export function sleep(clock: TestClock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const cancel = clock.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        cancel();
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A behaviour shaped like the agent: an LLM reply after `llmMs`, or a rules/Jev reply after
 * `fastMs` for input starting with "rule". It records what it was asked, every speculation hook
 * call, every cancellation and every playback receipt.
 */
export function slowAgent(clock: TestClock, { llmMs = 2500, fastMs = 100 } = {}) {
  const asked: string[] = [];
  const hooks: string[] = [];
  const receipts: string[] = [];
  let cancels = 0;
  const behavior: Behavior & TurnSpeculation = {
    respond: async () => '',
    async *respondStream(input, variables = {}) {
      if (variables.inputEvent === 'opening') {
        yield 'Hello, this is Asha.';
        return;
      }
      asked.push(input);
      await sleep(clock, input.startsWith('rule') ? fastMs : llmMs);
      yield `Answer: ${input}.`;
    },
    cancel: () => {
      cancels += 1;
    },
    onPlayback: (receipt) => {
      receipts.push(`${receipt.state}:${receipt.text}`);
    },
    prepare: (partial) => hooks.push(`prepare ${partial.turnId} ${partial.text}`),
    finalize: (final) =>
      hooks.push(`finalize ${final.turnId} ${final.text} merged=${final.merged}`),
    discard: (turnId, reason) => hooks.push(`discard ${turnId} ${reason}`),
  };
  return { behavior, asked, hooks, receipts, cancels: () => cancels };
}

/**
 * The turn driver over a scheduler whose fake output reports first audio after `ttsMs` (0 for a
 * cached filler clip) and plays each line for `playMs` (a filler clip for `fillerPlayMs`), all on a
 * fake clock. With `timing`, turn latency and speech timings reach the bus as engine events, as in
 * the native engine (VAD stop hangover `timing.hangoverMs`), and `latency` is the engine's own.
 */
export function driverHarness(
  clock: TestClock,
  behavior: Behavior & TurnSpeculation,
  {
    ttsMs = 200,
    playMs = 1500,
    fillerPlayMs = playMs,
    fillers = [] as string[],
    output,
    timing,
  }: {
    ttsMs?: number;
    playMs?: number;
    fillerPlayMs?: number;
    fillers?: string[];
    output?: SpeechOutput;
    timing?: { hangoverMs?: number; prefetchSegments?: number };
  } = {},
) {
  const bus = new VoiceEventBus();
  /** Each line whose audio reached the carrier, and when. */
  const audio: { text: string; atMs: number; kind: string }[] = [];
  /** Each line cut off after its audio reached the carrier, and when. */
  const cut: { text: string; atMs: number }[] = [];
  let timed: SpeechTimingSink | undefined;
  const fake: SpeechOutput & { configureTiming(sink: SpeechTimingSink): void } = {
    configureTiming: (sink) => (timed = sink),
    async play(segment, { signal, report }) {
      const clip = fillers.includes(segment.text);
      await sleep(clock, clip ? 0 : ttsMs, signal);
      if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      if (!clip) timed?.('tts-first-byte', segment);
      audio.push({ text: segment.text, atMs: clock.now(), kind: segment.kind });
      timed?.('carrier-first-audio', segment);
      report?.('sent', 'estimated');
      await sleep(clock, fillers.includes(segment.text) ? fillerPlayMs : playMs, signal);
      if (signal.aborted) cut.push({ text: segment.text, atMs: clock.now() });
      return signal.aborted
        ? { state: 'interrupted', evidence: 'estimated' }
        : { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  };
  // A real output (`output`) records no `audio` or `cut` here.
  const scheduler = timing
    ? new BoundedSpeechScheduler(output ?? fake, {}, () => clock.now())
    : new BoundedSpeechScheduler(output ?? fake);
  const ended: string[] = [];
  /** `reason` or `reason:detail`, for each end the driver asked for. */
  const endings: string[] = [];
  const latency = timing
    ? new TurnLatency(clock, (event) => bus.emit(event), timing.hangoverMs)
    : new TurnLatency(clock, () => undefined);
  const driver = new TurnDriver(
    behavior,
    scheduler,
    session,
    bus,
    latency,
    (reason, detail) => {
      ended.push(reason);
      endings.push(detail ? `${reason}:${detail}` : reason);
    },
    4,
    { sessionId: 's-1', playbackEvidence: 'carrier-played' } as MediaDuplex,
    clock,
  );
  if (timing) {
    const projector = new SpeechEventProjector(
      bus,
      latency,
      (epoch) => driver.turnIdForEpoch(epoch),
      (event) => bus.emit(event),
      (id) => driver.isFiller(id),
    );
    scheduler.configurePipeline(timing.prefetchSegments ?? 2);
    scheduler.configureSession(session);
    scheduler.configureTiming((phase, segment, elapsedMs) =>
      projector.onTiming(phase, segment, elapsedMs),
    );
    scheduler.subscribe((evidence) => projector.onSpeech(evidence));
  }
  let callerTurns = 0;
  const caller = (text: string, filler?: { text: string; afterMs: number }) =>
    driver.decide({
      type: 'turn.stopped',
      turnId: `turn-${++callerTurns}`,
      input: { kind: 'speech', text, segments: 1 },
      ...(filler ? { filler } : {}),
    } satisfies TurnDecision);
  /** Plays the opening, so the output has reported audio once, then returns the time. */
  const greet = async () => {
    driver.opening();
    await clock.advanceAsync(ttsMs + playMs + 1);
    audio.length = 0;
    return clock.now();
  };
  /** The detector's decisions for one caller turn, by id, and the VAD around it. */
  const turn = {
    started: (turnId: string) => driver.decide({ type: 'turn.started', turnId }),
    partial: (turnId: string, text: string) =>
      driver.decide({ type: 'turn.partial', turnId, text, stable: false }),
    stopped: (turnId: string, text: string, filler?: { text: string; afterMs: number }) =>
      driver.decide({
        type: 'turn.stopped',
        turnId,
        input: { kind: 'speech', text, segments: 1 },
        ...(filler ? { filler } : {}),
      }),
    reset: (turnId: string) => driver.decide({ type: 'turn.reset', turnId, reason: 'backchannel' }),
    vad: (type: 'vad.start' | 'vad.stop') => bus.observe({ type, atMs: clock.now() }),
  };
  return { driver, audio, cut, ended, endings, caller, greet, scheduler, bus, turn, latency };
}
