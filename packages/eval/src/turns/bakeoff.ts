import type { EndOfTurnModel } from '../../../plugin-turns/src/index.ts';
import { CALLS, loadCompact, transcriptTimeline, withAudio, type CallName } from './corpus.ts';
import { goldThoughts, type Thought } from './gold.ts';
import { GOLD_OVERRIDES } from './gold-overrides.ts';
import { replayCall, type ReplayResult, type Variant } from './replay.ts';
import { aggregate, percentile, scoreReplay, type Score } from './score.ts';
import type { Timeline } from './timeline.ts';

/**
 * The turn bake-off (Wave 13, T2): every call of the corpus through each detector variant, scored
 * against the gold thoughts. Text-reading variants run on all five calls; audio models only on the
 * calls with caller audio (7 and 8). `live` scores what each call's detector actually did.
 */
export interface ModelEntry {
  key: string;
  model: EndOfTurnModel & { timings: readonly number[] };
  /** Gate settings for this variant (threshold, holdMs, recheckMs, safety). */
  gate?: Record<string, unknown>;
  /** Also run it over the full rules (`<key>+rules`), not only over the rules without holds. */
  twin?: boolean;
}

/** The production rules (the detector's defaults, PHONE_TURN_CONFIG). */
export const RULES: Record<string, unknown> = {};
/** The rules without their own holds for trailing words (cutoffHoldMs 0 turns pauseHoldMs off too). */
export const RULES_NO_HOLDS: Record<string, unknown> = { cutoffHoldMs: 0 };

/**
 * The variants: the rules as they are, the rules without their holds, and each model entry gating
 * the rules without holds (the model decides what to wait for) and, for a `twin`, the full rules.
 */
export function variantsFor(models: readonly ModelEntry[]): Variant[] {
  return [
    { name: 'rules', row: RULES },
    { name: 'rules-noholds', row: RULES_NO_HOLDS },
    ...models.flatMap(({ key, model, gate = {}, twin }) => [
      { name: key, row: { ...RULES_NO_HOLDS, model: gate }, model },
      ...(twin ? [{ name: `${key}+rules`, row: { ...RULES, model: gate }, model }] : []),
    ]),
  ];
}

export interface CallRun {
  call: CallName;
  label: string;
  vad: Timeline['vad']['source'];
  alignment?: { offsetMs: number; matched: number; candidates: number };
  thoughts: Thought[];
  live: Score;
  results: { variant: string; score: Score; replay: ReplayResult }[];
}

export interface Bakeoff {
  calls: CallRun[];
  summary: { variant: string; calls: string[]; score: Omit<Score, 'detail'> }[];
  timings: { model: string; predictions: number; p50?: number; p90?: number; max?: number }[];
}

export async function runBakeoff(options: {
  corpusDir: string;
  models: readonly ModelEntry[];
  calls?: readonly CallName[];
  log?: (line: string) => void;
}): Promise<Bakeoff> {
  const log = options.log ?? (() => {});
  const variants = variantsFor(options.models);
  const calls: CallRun[] = [];
  const timingStart = new Map(options.models.map((m) => [m.key, m.model.timings.length]));
  for (const name of options.calls ?? CALLS) {
    const compact = loadCompact(name);
    const audio = withAudio(compact, options.corpusDir);
    const timeline: Timeline = audio ?? transcriptTimeline(compact);
    const thoughts = goldThoughts(timeline, GOLD_OVERRIDES[name]);
    const live = scoreReplay(
      {
        endpoints: compact.live
          .filter((turn) => turn.text !== null && !turn.reset)
          .map((turn) => ({ at: turn.endAt, text: turn.text!, reason: turn.rule ?? undefined })),
      },
      thoughts,
    );
    const run: CallRun = {
      call: name,
      label: compact.label,
      vad: timeline.vad.source,
      ...(audio ? { alignment: audio.alignment } : {}),
      thoughts,
      live,
      results: [],
    };
    for (const variant of variants) {
      if (variant.model?.input === 'audio' && !timeline.audio) continue;
      const replay = await replayCall(timeline, variant);
      run.results.push({ variant: variant.name, score: scoreReplay(replay, thoughts), replay });
      log(`${name} ${variant.name}: ${replay.endpoints.length} endpoints`);
    }
    calls.push(run);
  }
  const summary = summarize(calls);
  const timings = options.models.map(({ key, model }) => {
    const mine = model.timings.slice(timingStart.get(key) ?? 0);
    return {
      model: key,
      predictions: mine.length,
      p50: percentile(mine, 50),
      p90: percentile(mine, 90),
      ...(mine.length ? { max: Math.round(Math.max(...mine)) } : {}),
    };
  });
  return { calls, summary, timings };
}

/** Each variant summed over the calls it ran on; and over the audio calls alone (7 and 8). */
export function summarize(calls: readonly CallRun[]): Bakeoff['summary'] {
  const audio = calls.filter((run) => run.vad === 'audio');
  const group = (runs: readonly CallRun[], suffix: string) => {
    const names = [...new Set(runs.flatMap((run) => run.results.map((r) => r.variant)))];
    return [
      {
        variant: `live${suffix}`,
        calls: runs.map((run) => run.call),
        score: aggregate(runs.map((run) => run.live)),
      },
      ...names.map((variant) => {
        const mine = runs.flatMap((run) =>
          run.results
            .filter((r) => r.variant === variant)
            .map((r) => ({ call: run.call, score: r.score })),
        );
        return {
          variant: `${variant}${suffix}`,
          calls: mine.map((m) => m.call),
          score: aggregate(mine.map((m) => m.score)),
        };
      }),
    ];
  };
  return [...group(calls, ''), ...(audio.length ? group(audio, ' (audio calls)') : [])];
}

/** Bake-offs of the same calls run apart (models that cannot share a process), as one. */
export function mergeBakeoffs(parts: readonly Bakeoff[]): Bakeoff {
  const calls = new Map<CallName, CallRun>();
  for (const part of parts)
    for (const run of part.calls) {
      const known = calls.get(run.call);
      if (!known) calls.set(run.call, { ...run, results: [...run.results] });
      else
        for (const result of run.results)
          if (!known.results.some((r) => r.variant === result.variant)) known.results.push(result);
    }
  const merged = CALLS.flatMap((name) => (calls.has(name) ? [calls.get(name)!] : []));
  return {
    calls: merged,
    summary: summarize(merged),
    timings: parts.flatMap((part) => part.timings),
  };
}
