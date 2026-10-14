import { isBackchannel, TurnConfigSchema } from '../../../contracts/src/index.ts';
import type { Timeline } from './timeline.ts';

/**
 * Turn gold (Wave 13, T2): the caller's *thoughts*, the units a reply should answer. A thought is
 * the caller's speech runs (the VAD's runs on their audio, or the modelled runs) grouped while the
 * caller holds the floor: a gap shorter than `GAP_MS` with no reply of the agent's starting in it
 * continues the thought. Words the STT sent with no speech run behind them (an echo, a background
 * talker the VAD's caller gate ignored, noise transcribed) are not the caller unless an override
 * says so. A thought expects no reply when it has no words, or its words are only a backchannel
 * said over the agent ("haan", "okay" while it speaks); said in silence, "Yes." answers something.
 *
 * This is the turn lane's gold v0: derived by rule, then corrected by the per-call overrides in
 * gold-overrides.ts, each with its reason. The STT lane's word-level gold (packages/eval corpus
 * gold/) can replace the runs and the words once it lands; the grouping stays a judgement the
 * founder should review (docs/eval/turn-bakeoff.md lists the thoughts).
 */
export const GAP_MS = 2000;
/** The VAD's stopMs: a run's stop comes this long after the caller's voice ended. */
const HANGOVER_MS = 200;
/** Words this long after a run's stop are still that run's (Scribe's finals lag the audio). */
const WORDS_LAG_MS = 1500;

export interface Thought {
  id: string;
  /** When the caller's voice started and ended (the last run's stop less the hangover). */
  start: number;
  end: number;
  text: string;
  runs: number;
  /** The caller expects an answer (false: a backchannel, noise, or words that were not theirs). */
  reply: boolean;
  /** Why an override changed it, if one did. */
  note?: string;
}

export interface GoldOverrides {
  /** Transcript-only speech that was the caller after all (the time of one of its transcripts). */
  voiced?: { at: number; note: string }[];
  /** Force a boundary in the gap that contains `at`. */
  split?: { at: number; note: string }[];
  /** Force the gap that contains `at` to continue the thought. */
  merge?: { at: number; note: string }[];
  /** The thought containing `at` expects no reply (noise, a background talker, an echo). */
  noReply?: { at: number; note: string }[];
}

const BACKCHANNELS = TurnConfigSchema.parse({}).backchannels;

interface Run {
  start: number;
  stop: number;
}

/** The thoughts of a call (see above). */
export function goldThoughts(timeline: Timeline, overrides: GoldOverrides = {}): Thought[] {
  const runs: Run[] = [];
  let open: number | undefined;
  for (const event of timeline.vad.events) {
    if (event.type === 'vad.start') open ??= event.at;
    else if (open !== undefined) {
      runs.push({ start: open, stop: event.at });
      open = undefined;
    }
  }
  for (const voiced of overrides.voiced ?? []) {
    // The transcript's segment, from a little before its first words to its last revision.
    const seg = timeline.transcripts.find((t) => Math.abs(t.at - voiced.at) < 50)?.seg;
    const words = timeline.transcripts.filter((t) => t.seg === seg);
    if (!words.length) continue;
    runs.push({ start: words[0]!.at - 600, stop: words.at(-1)!.at + HANGOVER_MS });
  }
  runs.sort((a, b) => a.start - b.start);
  const replies = timeline.agent.filter((line) => line.kind !== 'acknowledgment');
  const groups: Run[][] = [];
  for (const run of runs) {
    const last = groups.at(-1)?.at(-1);
    const gap = last ? { from: last.stop - HANGOVER_MS, to: run.start } : undefined;
    const inGap = (at: number) => !!gap && at >= gap.from && at <= gap.to;
    const forced = (list?: { at: number }[]) => list?.some((o) => inGap(o.at)) ?? false;
    const continues =
      !!gap &&
      !forced(overrides.split) &&
      (forced(overrides.merge) ||
        (gap.to - gap.from < GAP_MS && !replies.some((line) => inGap(line.start))));
    if (continues) groups.at(-1)!.push(run);
    else groups.push([run]);
  }
  return groups.map((group, index) => {
    const start = group[0]!.start;
    const end = group.at(-1)!.stop - HANGOVER_MS;
    const text = wordsOf(timeline, start, end + WORDS_LAG_MS);
    const note = overrides.noReply?.find((o) => o.at >= start && o.at <= end + HANGOVER_MS)?.note;
    const bare = !text.replace(/[\s.,!?।]/g, '');
    const overAgent = timeline.agent.some((line) => line.start < end && line.stop > start);
    const backchannel =
      overAgent &&
      isBackchannel(text, 'en', {
        backchannels: BACKCHANNELS,
        backchannelsEnabled: true,
        minWordsWhileBotSpeaking: 0,
      });
    return {
      id: `t${index + 1}`,
      start,
      end,
      text,
      runs: group.length,
      reply: !note && !bare && !backchannel,
      ...(note ? { note } : {}),
    };
  });
}

/** The caller's words between `from` and `to`: each segment's last text, in order. */
function wordsOf(timeline: Timeline, from: number, to: number): string {
  const last = new Map<string, string>();
  for (const t of timeline.transcripts) if (t.at >= from && t.at <= to) last.set(t.seg, t.text);
  return [...last.values()].join(' ').trim();
}
