import type {
  Clock,
  SpeechCapabilities,
  SpeechKindV2,
  VoiceEvent,
} from '@winsendotai/ovo-contracts';
import { createTurnDetector } from '../src/index.ts';

/**
 * Wave 8 endpoint replays of live calls: Maya 6e1a4e3a (2026-10-08, a café) and f3363705
 * (2026-10-07). The detector gets the events a turn had, Scribe answers each host commit after the
 * latency the turn measured, and the endpoint is timed as the engine does (plugin-voice
 * TurnLatency.accept): from the VAD stop plus its 200 ms hangover, or from the last change of the
 * caller's words when the VAD never stopped.
 */
type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;
/** The conformance kit's FakeClock (a tests/ helper may not import the kit itself). */
type ReplayClock = Clock & { advance(ms: number): void };

const scribe: SpeechCapabilities = {
  languages: ['en'],
  interim: true,
  wordTimestamps: false,
  forceEndpoint: true,
  turnSignals: [],
};
const VAD_STOP_MS = 200;

/** Maya's turn detector row on those calls. */
export const MAYA = {
  strategy: 'commit',
  commit: { silenceMs: 450, minSpeechMs: 180, stallMs: 1500 },
  minWordsWhileBotSpeaking: 3,
  backchannels: ['uh huh', 'mm hmm', 'yeah', 'yes', 'ok', 'okay', 'right', 'haan', 'hmm', 'ji'],
  filler: { lines: ['One moment.'], afterMs: 1500 },
};
/** The same row with the Wave 8 rules off: the detector as it ran on the live calls. */
export const LIVE = {
  ...MAYA,
  commit: { ...MAYA.commit, completeSilenceMs: 450, answerStallMs: 0, commitAtStop: false },
  noiseMs: 0,
  questionReplyMs: 0,
};
/** The recommended row: Maya's without its commit.silenceMs 450, now unnecessary. */
export const RECOMMENDED = { ...MAYA, commit: { minSpeechMs: 180, stallMs: 1500 } };

export interface ReplayedTurn {
  text: string;
  endpointMs: number;
  reason?: string;
  /** When the turn ended, from the replay's start. */
  atMs: number;
  /** The filler line offered with the turn (LAT-6), if any. */
  filler?: string;
}

/** Wave 12: start the replay before the opening has played (call 8cb76efc turn 6). */
export interface ReplayOptions {
  opening?: boolean;
}

export function replay(
  clock: ReplayClock,
  row: Record<string, unknown>,
  options: ReplayOptions = {},
) {
  const controller = createTurnDetector(row).create({
    clock,
    vad: true,
    language: 'en-IN',
    mode: 'agent',
    stt: scribe,
  });
  const turns: ReplayedTurn[] = [];
  const resets: string[] = [];
  const resetTexts: (string | undefined)[] = [];
  /** Scribe's answers to the next host commits: after `latencyMs`, or (Wave 10) at `atMs`. */
  const commits: { text: string; latencyMs: number; atMs?: number }[] = [];
  let forced = 0;
  const forcedAt: number[] = [];
  /** Wave 12: an STT model of its own, told of each host commit (`onForced`). */
  const forcedListeners: (() => void)[] = [];
  /** Wave 10: the caller's words each time they were announced stable (the LLM is asked then). */
  const stable: { text: string; atMs: number }[] = [];
  let segment = 0;
  let revision = 0;
  let vadStopAt: number | undefined;
  let wordsAt: number | undefined;
  let words = '';
  const send = (event: WithoutTime<VoiceEvent>) => {
    if (event.type === 'vad.stop') vadStopAt = clock.now();
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  };
  const transcript = (text: string, stability: 'interim' | 'final') => {
    if (text && text !== words) [words, wordsAt] = [text, clock.now()];
    const event = { segmentId: String(segment), revision: ++revision, text, stability };
    send({ type: 'stt', event: { type: 'transcript', segment: event } });
  };
  /** Scribe's lock(): the committed transcript (none when empty), its end-of-turn, a new segment. */
  const final = (text: string) => {
    if (text) transcript(text, 'final');
    send({ type: 'stt', event: { type: 'end-of-turn' } });
    segment++;
  };
  controller.on((decision) => {
    if (decision.type === 'force-endpoint') {
      forced++;
      forcedAt.push(clock.now());
      for (const listener of forcedListeners) listener();
      const next = commits.shift();
      if (next) {
        const delayMs = next.atMs === undefined ? next.latencyMs : next.atMs - clock.now();
        clock.setTimeout(() => final(next.text), Math.max(0, delayMs));
      }
    } else if (decision.type === 'turn.partial' && decision.stable) {
      stable.push({ text: decision.text, atMs: clock.now() });
    } else if (decision.type === 'turn.reset') {
      resets.push(decision.reason);
      resetTexts.push(decision.text);
    } else if (decision.type === 'turn.stopped' && decision.input.kind === 'speech') {
      const atMs = clock.now();
      const endpointMs =
        vadStopAt !== undefined ? atMs - vadStopAt + VAD_STOP_MS : atMs - (wordsAt ?? atMs);
      const filler = decision.filler?.text;
      turns.push({
        text: decision.input.text,
        endpointMs,
        reason: decision.reason,
        atMs,
        ...(filler ? { filler } : {}),
      });
      vadStopAt = wordsAt = undefined;
      words = '';
    }
  });
  // Mid-call: the opening has played.
  if (!options.opening) {
    send({ type: 'bot.started', epoch: 0, kind: 'response' });
    send({ type: 'bot.stopped', epoch: 0, kind: 'response' });
  }
  let epoch = 0;
  let kind: SpeechKindV2 = 'response';
  return {
    clock,
    turns,
    resets,
    /** The words each reset dropped (Wave 9). */
    resetTexts,
    /** Host commits (force-endpoint) so far. */
    forced: () => forced,
    /** When each host commit was sent (Wave 10). */
    forcedAt: () => [...forcedAt],
    /** The words announced stable, and when (Wave 10). */
    stable: () => [...stable],
    send,
    interim: (text: string) => transcript(text, 'interim'),
    final,
    /** Scribe's answer to the next host commit: `text` (none when empty) after `latencyMs`. */
    commits: (text: string, latencyMs: number) => void commits.push({ text, latencyMs }),
    /** Scribe's answer to the next host commit: `text` at `atMs` on the clock, or at once if later. */
    commitsAt: (text: string, atMs: number) => void commits.push({ text, latencyMs: 0, atMs }),
    agentStarts: (question = false) => {
      kind = 'response';
      send({ type: 'bot.started', epoch: ++epoch, kind, question });
    },
    /** Wave 12: a filler or search line ("Let me look that up."), or the opening's disclosure. */
    agentSays: (said: 'filler' | 'disclosure') => {
      kind = said === 'filler' ? 'acknowledgment' : 'disclosure';
      send({ type: 'bot.started', epoch: ++epoch, kind, filler: said === 'filler' });
    },
    agentStops: () => send({ type: 'bot.stopped', epoch, kind }),
    /** Wave 12: runs `listener` on each host commit, before any queued answer is scheduled. */
    onForced: (listener: () => void) => void forcedListeners.push(listener),
    /**
     * A heard utterance of `ms`, Scribe's interims changing once a second as on the live calls
     * (`interims[i]` at (i + 1) s), then the VAD stop and the final `latencyMs` after the commit.
     */
    utter(ms: number, text: string, latencyMs: number, interims: string[] = []) {
      commits.push({ text, latencyMs });
      send({ type: 'vad.start' });
      for (const [i, interim] of interims.entries()) {
        clock.advance(i ? 1000 : Math.min(1000, ms));
        transcript(interim, 'interim');
      }
      clock.advance(ms - Math.min(ms, 1000 * interims.length));
      send({ type: 'vad.stop' });
      clock.advance(5000);
    },
  };
}
