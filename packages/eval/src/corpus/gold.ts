// GOLD transcripts (`gold/<call>.json`): what the caller actually said, utterance by utterance, on
// the call's event timeline (ms since `session.started`). Written by the STT lane from the caller
// audio; docs/eval/gold-format.md is the reference. Parsed leniently, so seconds and the STT lane's
// draft field names are accepted too.
import { z } from 'zod';

const Confidence = z.union([z.number().min(0).max(1), z.enum(['high', 'medium', 'low'])]);

const RawUtterance = z
  .object({
    id: z.string().min(1),
    startMs: z.number().optional(),
    endMs: z.number().optional(),
    /** Seconds, when the file says `"units": "s"` or has no `startMs`. */
    start: z.number().optional(),
    end: z.number().optional(),
    /** The words as said: English in Latin script, Hindi romanised (canonical). */
    text: z.string(),
    /** Hindi in Devanagari, when Hindi was spoken. */
    devanagari: z.string().optional(),
    romanised: z.string().optional(),
    /** Other equally correct transcripts (digits as words, another spelling). */
    accept: z.array(z.string()).optional(),
    /** BCP-47 base or `mixed` (Hinglish code-switching). */
    language: z.string().optional(),
    /** Utterances of one thought share an id: the caller paused mid-thought and went on. */
    thought: z.string().optional(),
    /** False for a backchannel ("mm", "haan" over the agent) that wants no reply. */
    expectsReply: z.boolean().optional(),
    backchannel: z.boolean().optional(),
    overAgent: z.boolean().optional(),
    confidence: Confidence.optional(),
    needsFounderReview: z.boolean().optional(),
    note: z.string().optional(),
  })
  .passthrough();

const RawGold = z
  .object({
    call: z.string().optional(),
    callId: z.string().optional(),
    units: z.enum(['ms', 's']).optional(),
    /** Call time = caller-track time + offsetMs, as the STT lane aligned it. */
    offsetMs: z.number().optional(),
    alignment: z.object({ offsetMs: z.number() }).passthrough().optional(),
    utterances: z.array(RawUtterance),
    needsFounderReview: z.array(z.string()).optional(),
  })
  .passthrough();

export interface GoldUtterance {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  /** Every accepted transcript: the text, its Devanagari and romanised forms, `accept`. */
  references: string[];
  language?: string;
  thought: string;
  expectsReply: boolean;
  overAgent: boolean;
  lowConfidence: boolean;
}

/** A conversational turn the agent should answer once: one or more utterances. */
export interface GoldThought {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  utterances: GoldUtterance[];
  expectsReply: boolean;
}

export interface Gold {
  callId?: string;
  offsetMs?: number;
  utterances: GoldUtterance[];
  thoughts: GoldThought[];
  needsReview: string[];
}

export function parseGold(value: unknown): Gold {
  const raw = RawGold.parse(value);
  const seconds = (ms: number | undefined, s: number | undefined) =>
    raw.units !== 's' && ms !== undefined ? ms : s !== undefined ? s * 1000 : ms;
  const utterances = raw.utterances
    .map((u): GoldUtterance => {
      const startMs = seconds(u.startMs, u.start);
      const endMs = seconds(u.endMs, u.end);
      if (startMs === undefined || endMs === undefined || endMs < startMs)
        throw new Error(`gold utterance ${u.id}: needs startMs <= endMs`);
      const backchannel = u.backchannel ?? false;
      const references = [u.text, u.romanised, u.devanagari, ...(u.accept ?? [])].filter(
        (text): text is string => typeof text === 'string' && text.trim() !== '',
      );
      return {
        id: u.id,
        startMs,
        endMs,
        text: u.text,
        references: [...new Set(references)],
        ...(u.language ? { language: u.language } : {}),
        thought: u.thought ?? u.id,
        expectsReply: u.expectsReply ?? !backchannel,
        overAgent: u.overAgent ?? false,
        lowConfidence:
          u.needsFounderReview === true ||
          u.confidence === 'low' ||
          (typeof u.confidence === 'number' && u.confidence < 0.5),
      };
    })
    .sort((a, b) => a.startMs - b.startMs);
  const offsetMs = raw.offsetMs ?? raw.alignment?.offsetMs;
  return {
    ...(raw.callId ? { callId: raw.callId } : {}),
    ...(offsetMs === undefined ? {} : { offsetMs }),
    utterances,
    thoughts: thoughtsOf(utterances),
    needsReview: [
      ...new Set([
        ...(raw.needsFounderReview ?? []),
        ...utterances.filter((u) => u.lowConfidence).map((u) => u.id),
      ]),
    ],
  };
}

/** Groups utterances by `thought`, in time order; a thought expects a reply if any part does. */
export function thoughtsOf(utterances: readonly GoldUtterance[]): GoldThought[] {
  const byId = new Map<string, GoldThought>();
  const order: GoldThought[] = [];
  for (const utterance of utterances) {
    const known = byId.get(utterance.thought);
    if (known) {
      known.utterances.push(utterance);
      known.startMs = Math.min(known.startMs, utterance.startMs);
      known.endMs = Math.max(known.endMs, utterance.endMs);
      known.text = `${known.text} ${utterance.text}`;
      known.expectsReply ||= utterance.expectsReply;
      continue;
    }
    const thought: GoldThought = {
      id: utterance.thought,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      text: utterance.text,
      utterances: [utterance],
      expectsReply: utterance.expectsReply,
    };
    byId.set(thought.id, thought);
    order.push(thought);
  }
  return order.sort((a, b) => a.startMs - b.startMs);
}
