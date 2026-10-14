// The gold reference for a call: what the caller actually said, utterance by utterance, with when.
// `corpus/gold/<call>.json` in the format of docs/eval/gold-format.md, which the call-eval
// harness reads; the fields it does not know (the audio times, the candidates, the reasoning and
// the non-speech regions) are the STT lane's working and evidence.

export type GoldConfidence = 'high' | 'medium' | 'low';

/** A region of the caller track the speech finder kept that held no words. */
export interface GoldRegion {
  id: string;
  /** On the call's event timeline: ms since `session.started`. */
  startMs: number;
  endMs: number;
  /** On the caller track (`callN-caller.wav`). */
  audioStartMs: number;
  audioEndMs: number;
  /** The user turns the live call opened while this was on the line. */
  productionTurnIds: string[];
  /** What the live call's STT (Scribe v2 realtime, auto language) finalised for it. */
  productionText: string;
  /** Every STT configuration's transcript of it, by configuration id, for review. */
  candidates: Record<string, string>;
  /** What it is, and why it holds no words. */
  note: string;
}

export interface GoldUtterance extends GoldRegion {
  /** The words said: English in Latin script, Hindi romanised as Hinglish is typed. */
  text: string;
  /** The same words with the Hindi in Devanagari; present whenever Hindi is spoken. */
  devanagari?: string;
  /** Other equally correct transcripts (digits as words, another spelling). */
  accept?: string[];
  /** `en`, `hi`, `mixed` (Hinglish), or another base code. */
  language: string;
  /** Utterances of one caller thought share an id; a turn detector answers once per thought. */
  thought: string;
  /** False for a backchannel that wants no reply. */
  expectsReply: boolean;
  confidence: GoldConfidence;
  needsFounderReview?: boolean;
  /** Why this transcript: which candidates agreed, what context settled a disagreement. */
  reasoning: string;
}

export interface GoldCall {
  call: string;
  callId: string;
  units: 'ms';
  /** Call time = caller-track time + offsetMs. */
  offsetMs: number;
  audio: string;
  method: string;
  alignment: { offsetMs: number; matched: number; turns: number; medianErrorMs: number };
  segmentation: Record<string, number>;
  utterances: GoldUtterance[];
  /** Regions with no words: STT output there is an insertion. Not utterances to the harness. */
  nonSpeech: GoldRegion[];
  /** Ids of utterances a person should listen to before their numbers are trusted. */
  needsFounderReview: string[];
}

/** The transcripts a hypothesis may match: romanised or Devanagari Hindi, and any alternatives. */
export function goldReferences(utterance: GoldUtterance): string[] {
  return [utterance.text, utterance.devanagari, ...(utterance.accept ?? [])].filter(
    (text): text is string => typeof text === 'string' && text.trim() !== '',
  );
}

/** The base codes the caller spoke, for misdetection: `mixed` is Hindi and English. */
export function spokenLanguages(utterance: Pick<GoldUtterance, 'language'>): string[] {
  return utterance.language === 'mixed' ? ['en', 'hi'] : [utterance.language];
}

/** Every region of the call in track order, words or not: what the bake-off streams. */
export function allRegions(gold: GoldCall): GoldRegion[] {
  return [...gold.utterances, ...gold.nonSpeech].sort((a, b) => a.audioStartMs - b.audioStartMs);
}

function checkTimes(region: GoldRegion, at: string): void {
  for (const field of ['startMs', 'endMs', 'audioStartMs', 'audioEndMs'] as const)
    if (!Number.isFinite(region[field])) throw new Error(`${at}.${field} is not a number`);
  if (region.endMs <= region.startMs) throw new Error(`${at} ends before it starts`);
}

/** Checks a gold file's shape, naming the field at fault, so a hand edit cannot break scoring. */
export function parseGold(value: unknown): GoldCall {
  const gold = value as GoldCall;
  if (!gold || typeof gold.call !== 'string' || !Array.isArray(gold.utterances))
    throw new Error('gold file needs `call` and `utterances`');
  if (!Array.isArray(gold.nonSpeech)) throw new Error(`${gold.call}.nonSpeech is missing`);
  const ids = new Set<string>();
  for (const [index, region] of allRegions(gold).entries()) {
    const at = `${gold.call}.${region.id ?? index}`;
    if (typeof region.id !== 'string' || ids.has(region.id))
      throw new Error(`${at}: id is missing or duplicated`);
    ids.add(region.id);
    checkTimes(region, at);
  }
  const regions = allRegions(gold);
  for (let i = 1; i < regions.length; i += 1)
    if (regions[i]!.startMs < regions[i - 1]!.endMs)
      throw new Error(`${gold.call}.${regions[i]!.id} overlaps ${regions[i - 1]!.id}`);
  for (const utterance of gold.utterances) {
    const at = `${gold.call}.${utterance.id}`;
    if (typeof utterance.text !== 'string' || !utterance.text.trim())
      throw new Error(`${at}.text is empty (a region without words belongs in nonSpeech)`);
    if (/\p{Script=Devanagari}/u.test(utterance.text))
      throw new Error(`${at}.text must be romanised; Devanagari goes in devanagari`);
    if (typeof utterance.language !== 'string' || !utterance.language)
      throw new Error(`${at}.language is missing`);
    if ((utterance.language === 'hi' || utterance.language === 'mixed') && !utterance.devanagari)
      throw new Error(`${at} is ${utterance.language} but has no devanagari form`);
    if (!['high', 'medium', 'low'].includes(utterance.confidence))
      throw new Error(`${at}.confidence must be high, medium or low`);
    if (typeof utterance.thought !== 'string' || !utterance.thought)
      throw new Error(`${at}.thought is missing`);
  }
  const speech = new Set(gold.utterances.map((utterance) => utterance.id));
  for (const id of gold.needsFounderReview ?? [])
    if (!speech.has(id)) throw new Error(`needsFounderReview names unknown utterance ${id}`);
  return gold;
}
