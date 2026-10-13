import call5 from './fixtures/call5-endpoints.json' with { type: 'json' };
import call6 from './fixtures/call6-endpoints.json' with { type: 'json' };
import { RECOMMENDED, replay } from './replay.ts';

/**
 * Wave 10 (call 4f1a919d, L1): every caller turn of Maya calls 10d5ef30 (call 5) and 4f1a919d
 * (call 6) replayed one at a time through the turn detector, from the engine events of each call
 * (fixtures/call{5,6}-endpoints.json, built from /tmp/ovo/c5ev.json and call6-events.jsonl). Times
 * are ms from each call's first engine event.
 *
 * Measured: every interim and final (`user.transcript`), when each turn started (`user.turn`) and
 * ended, its live `endpointMs`, and so its VAD stop (the end, less `endpointMs`, plus the VAD's 200
 * ms hangover). Modelled, and marked so: the VAD opened the turn at its start when the first words
 * came later (otherwise with the first words) and heard the caller until that stop, so finals
 * before it are segments the caller went on after; Scribe answers a host commit after the latency
 * the live turn measured, read off a replay with the live row (`calibrate`): from the commit that
 * row sends to the turn's last final. Turns over the agent (call 5 turns 6 and 11) are left to
 * call5-replay.test.ts; call 6 turn 9 barged in on "Shall I end the call?" and is replayed as if
 * the agent were quiet, which its endpoint does not depend on.
 */
export interface FixtureTranscript {
  at: number;
  seg: string;
  text: string;
  final: boolean;
}
export interface FixtureTurn {
  id: string;
  startedAt: number;
  endAt: number;
  text: string | null;
  rule: string | null;
  endpointMs: number | null;
  vadStopWaitMs: number | null;
  answering: boolean;
  overAgent: boolean;
  transcripts: FixtureTranscript[];
}

/** A fresh clock for each replay: the conformance kit's FakeClock (a helper may not import it). */
export type NewClock = () => Parameters<typeof replay>[0];

export const CALLS = { call5: call5.turns as FixtureTurn[], call6: call6.turns as FixtureTurn[] };

/** The VAD's stopMs: the hangover the engine adds back to every endpoint. */
const HANGOVER_MS = 200;
/** A VAD run that stopped before the turn's first words: modelled as starting this long before. */
const VAD_LEAD_MS = 300;
/**
 * A segment final inside a turn: its VAD stop came this long before it (Scribe's ~350 ms after the
 * live row's longest 250 ms commit wait), and the caller's voice again this long before it.
 */
const PAUSE_MS = 600;
const RESUME_MS = 250;
const LEAD_MS = 2_000;

/** The detector as it ran on call 6 (main 54fd9ea): Maya's row with Wave 9's defaults. */
export const BEFORE = {
  ...RECOMMENDED,
  commit: { ...RECOMMENDED.commit, commitAtStop: false, completeSilenceMs: 50 },
};
/** Maya's row with this wave's defaults. */
export const AFTER = RECOMMENDED;

export interface Replayed {
  id: string;
  /** The turns the detector made of the words: one, unless it split them. */
  texts: string[];
  reason?: string;
  endpointMs?: number;
  /** When the (last) turn ended, from the live turn's start. */
  atMs?: number;
}

/** The live turn's VAD stop, when its endpoint was timed from one. */
function vadStopOf(turn: FixtureTurn): number | undefined {
  if (turn.vadStopWaitMs === null || turn.endpointMs === null) return undefined;
  return turn.endAt - turn.endpointMs + HANGOVER_MS;
}

/** The final a host commit answered: the turn's last, unless it came before the VAD stop. */
function committedFinal(turn: FixtureTurn): FixtureTranscript | undefined {
  const last = turn.transcripts.findLast((entry) => entry.final);
  const stop = vadStopOf(turn);
  return last && (stop === undefined || last.at > stop) ? last : undefined;
}

/**
 * Replays one live turn through the detector built from `row`. `latency` is Scribe's answer to the
 * host commit; undefined calibrates it (`calibrate`), null leaves the commit unanswered.
 */
export function replayTurn(
  newClock: NewClock,
  row: Record<string, unknown>,
  turn: FixtureTurn,
  latency?: number | null,
  /** How much sooner than live `row` commits: Scribe's last partials before its answer move too. */
  soonerMs = 0,
): Replayed & { forcedAt: number[] } {
  // null: Scribe never answers the commit (calibrating).
  const latencyMs = latency === undefined ? calibrate(newClock, turn) : latency;
  const f = replay(newClock(), row);
  if (turn.answering) {
    f.agentStarts(true);
    f.agentStops();
  }
  // The replay's clock starts LEAD_MS before the turn: its VAD run may have started earlier.
  const origin = f.clock.now() - (turn.startedAt - LEAD_MS);
  const at = (ms: number) => f.clock.advance(Math.max(0, origin + ms - f.clock.now()));
  const committed = committedFinal(turn);
  const first = turn.transcripts[0];
  const stop = vadStopOf(turn);
  // The VAD opened the turn, or heard the caller before their first words reached the engine.
  const vadOpened =
    stop !== undefined && (!first || first.at > turn.startedAt + 5 || first.at >= stop);
  const steps: { at: number; run: () => void }[] = [];
  if (vadOpened)
    steps.push({
      at: Math.min(turn.startedAt, stop - VAD_LEAD_MS),
      run: () => f.send({ type: 'vad.start' }),
    });
  for (const [index, entry] of turn.transcripts.entries()) {
    if (entry === committed) continue;
    const next = turn.transcripts[index + 1];
    // A partial of the committed segment after the stop came just before Scribe's answer, and
    // comes as much sooner as the commit does.
    const late = stop !== undefined && entry.seg === committed?.seg && entry.at > stop;
    if (!entry.final)
      steps.push({ at: entry.at - (late ? soonerMs : 0), run: () => f.interim(entry.text) });
    else if (stop === undefined || !next || entry.at >= stop)
      steps.push({ at: entry.at, run: () => f.final(entry.text) });
    else {
      // A segment the caller went on after (modelled): the VAD stopped PAUSE_MS before its final and
      // heard the caller again RESUME_MS before it, so the live turn went on; the commit that stop
      // sent is answered by the final as measured. A turn is compared at its end only.
      f.commitsAt(entry.text, origin + entry.at);
      steps.push({ at: entry.at - PAUSE_MS, run: () => f.send({ type: 'vad.stop' }) });
      steps.push({ at: entry.at - RESUME_MS, run: () => f.send({ type: 'vad.start' }) });
    }
  }
  if (committed && latencyMs !== null && latencyMs !== undefined)
    f.commits(committed.text, latencyMs);
  // A VAD that heard the caller only after the first words: it started with them.
  if (stop !== undefined && !vadOpened && first)
    steps.push({ at: first.at, run: () => f.send({ type: 'vad.start' }) });
  if (stop !== undefined) steps.push({ at: stop, run: () => f.send({ type: 'vad.stop' }) });
  steps.sort((a, b) => a.at - b.at);
  for (const step of steps) {
    at(step.at);
    step.run();
  }
  f.clock.advance(10_000);
  const last = f.turns.at(-1);
  return {
    id: turn.id,
    texts: f.turns.map((entry) => entry.text),
    ...(last
      ? { reason: last.reason, endpointMs: Math.round(last.endpointMs), atMs: last.atMs - origin }
      : {}),
    forcedAt: f.forcedAt().map((ms) => ms - origin),
  };
}

/**
 * Scribe's latency for the turn's commit: from the commit the live row sends (replayed without
 * the final) to the final's measured arrival.
 */
export function calibrate(newClock: NewClock, turn: FixtureTurn): number | undefined {
  const final = committedFinal(turn);
  const commit = commitOf(newClock, BEFORE, turn);
  return final && commit !== undefined ? final.at - commit : undefined;
}

/** When `row` sends the commit the turn's last final answers (none: undefined). */
function commitOf(
  newClock: NewClock,
  row: Record<string, unknown>,
  turn: FixtureTurn,
): number | undefined {
  const final = committedFinal(turn);
  if (!final) return undefined;
  return replayTurn(newClock, row, turn, null).forcedAt.findLast((ms) => ms <= final.at);
}

/** One live turn through `row`, Scribe answering its commit as it answered the live one. */
export function replayLive(
  newClock: NewClock,
  row: Record<string, unknown>,
  turn: FixtureTurn,
): Replayed {
  const live = commitOf(newClock, BEFORE, turn);
  const replayed = commitOf(newClock, row, turn);
  const soonerMs = live === undefined || replayed === undefined ? 0 : live - replayed;
  const latency = calibrate(newClock, turn);
  const { forcedAt: _, ...result } = replayTurn(newClock, row, turn, latency, soonerMs);
  return result;
}
