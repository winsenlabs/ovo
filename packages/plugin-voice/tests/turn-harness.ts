import type {
  Behavior,
  Clock,
  MediaDuplex,
  SessionInput,
  TurnDecision,
  TurnSpeculation,
} from '@winsendotai/ovo-contracts';
import { VoiceEventBus } from '../src/engine/events.ts';
import { TurnLatency } from '../src/engine/latency.ts';
import { TurnDriver } from '../src/engine/turn-driver.ts';
import { BoundedSpeechScheduler } from '../src/scheduler.ts';

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
 * cached filler clip) and plays each line for `playMs`, all on a fake clock.
 */
export function driverHarness(
  clock: TestClock,
  behavior: Behavior & TurnSpeculation,
  { ttsMs = 200, playMs = 1500, fillers = [] as string[] } = {},
) {
  const bus = new VoiceEventBus();
  /** Each line whose audio reached the carrier, and when. */
  const audio: { text: string; atMs: number; kind: string }[] = [];
  /** Each line cut off after its audio reached the carrier, and when. */
  const cut: { text: string; atMs: number }[] = [];
  const scheduler = new BoundedSpeechScheduler({
    async play(segment, { signal, report }) {
      await sleep(clock, fillers.includes(segment.text) ? 0 : ttsMs, signal);
      if (signal.aborted) return { state: 'interrupted', evidence: 'estimated' };
      audio.push({ text: segment.text, atMs: clock.now(), kind: segment.kind });
      report?.('sent', 'estimated');
      await sleep(clock, playMs, signal);
      if (signal.aborted) cut.push({ text: segment.text, atMs: clock.now() });
      return signal.aborted
        ? { state: 'interrupted', evidence: 'estimated' }
        : { state: 'completed', evidence: 'confirmed' };
    },
    async interrupt() {},
  });
  const ended: string[] = [];
  /** `reason` or `reason:detail`, for each end the driver asked for. */
  const endings: string[] = [];
  const driver = new TurnDriver(
    behavior,
    scheduler,
    session,
    bus,
    new TurnLatency(clock, () => undefined),
    (reason, detail) => {
      ended.push(reason);
      endings.push(detail ? `${reason}:${detail}` : reason);
    },
    4,
    { sessionId: 's-1', playbackEvidence: 'carrier-played' } as MediaDuplex,
    clock,
  );
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
  return { driver, audio, cut, ended, endings, caller, greet, scheduler, bus, turn };
}
