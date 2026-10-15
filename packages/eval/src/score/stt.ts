// What the STT wrote against what the caller said. The call-level WER and CER compare the whole
// call's words in order (a final often spans several utterances, so per-utterance cuts would count
// one misplaced commit as errors twice); per-utterance rows are for reading only.
import type { Gold, GoldUtterance } from '../corpus/gold.ts';
import type { Transcript } from '../timeline.ts';
import { scoringWords } from './hinglish.ts';
import { foreignTranscript, mismatchesGold } from './language.ts';
import { charErrors, editDistance, wordErrors, type ErrorCount } from './wer.ts';

export interface SegmentText {
  segmentId: string;
  atMs: number;
  text: string;
  final: boolean;
}

/**
 * The STT's words per segment: its final, or for a segment never finalised (the call ended, or it
 * was muted) its last interim. Segment ids restart when a session reconnects, so a final closes
 * its id and a later interim under it opens a new segment.
 */
export function segmentTexts(transcripts: readonly Transcript[]): SegmentText[] {
  const open = new Map<string, SegmentText>();
  const out: SegmentText[] = [];
  for (const transcript of transcripts) {
    const known = open.get(transcript.segmentId);
    if (known && !known.final) {
      known.text = transcript.text;
      known.atMs = transcript.atMs;
      known.final = transcript.final;
      continue;
    }
    const entry = { ...transcript };
    open.set(transcript.segmentId, entry);
    out.push(entry);
  }
  return out.filter((entry) => entry.text.trim());
}

export interface UtteranceRow {
  id: string;
  startMs: number;
  endMs: number;
  gold: string;
  heard: string;
  wer: number | null;
  languageMismatch: boolean;
  lowConfidence: boolean;
}

export interface SttScore {
  wer: number | null;
  cer: number | null;
  /** Word and character edits over the reference's words and characters (0 without gold). */
  edits: number;
  words: number;
  charEdits: number;
  chars: number;
  /** Segments written in a language the caller was not speaking. */
  foreignSegments: number;
  foreignInterims: number;
  /** Gold utterances whose transcript is in the wrong language for what was said. */
  languageMismatches: number | null;
  rows: UtteranceRow[];
}

/** The segment texts heard for each utterance: those finalised during it or within 3 s after. */
function heardFor(utterances: readonly GoldUtterance[], segments: readonly SegmentText[]) {
  const heard = new Map<string, SegmentText[]>();
  for (const segment of segments) {
    const candidates = utterances.filter(
      (u) => u.startMs <= segment.atMs - 150 && segment.atMs <= u.endMs + 3000,
    );
    const target = candidates.at(-1);
    if (target) heard.set(target.id, [...(heard.get(target.id) ?? []), segment]);
  }
  return heard;
}

export function sttScore(
  transcripts: readonly Transcript[],
  gold: Gold | undefined,
  languages: readonly string[],
): SttScore {
  const segments = segmentTexts(transcripts);
  const foreignSegments = segments.filter(
    (s) => foreignTranscript(s.text, languages).foreign,
  ).length;
  const foreignInterims = transcripts.filter(
    (t) => !t.final && foreignTranscript(t.text, languages).foreign,
  ).length;
  if (!gold?.utterances.length)
    return {
      wer: null,
      cer: null,
      edits: 0,
      words: 0,
      charEdits: 0,
      chars: 0,
      foreignSegments,
      foreignInterims,
      languageMismatches: null,
      rows: [],
    };
  const heard = heardFor(gold.utterances, segments);
  const rows: UtteranceRow[] = [];
  const chosen: string[] = [];
  for (const utterance of gold.utterances) {
    const text = (heard.get(utterance.id) ?? []).map((s) => s.text).join(' ');
    // The rendering closest to what was heard stands for the utterance in the call-level score.
    const errors = utterance.references.map((reference) => wordErrors([reference], text));
    const best = errors.reduce<{ index: number; count: ErrorCount }>(
      (min, count, index) =>
        count.errors / Math.max(1, count.length) < min.count.errors / Math.max(1, min.count.length)
          ? { index, count }
          : min,
      { index: 0, count: errors[0]! },
    );
    chosen.push(utterance.references[best.index]!);
    rows.push({
      id: utterance.id,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      gold: utterance.text,
      heard: text,
      wer: best.count.length ? best.count.errors / best.count.length : null,
      languageMismatch: mismatchesGold(text, utterance.language, languages),
      lowConfidence: utterance.lowConfidence,
    });
  }
  const said = segments.map((s) => s.text).join(' ');
  const reference = chosen.join(' ');
  const words = scoringWords(reference);
  const wordEdits = editDistance(words, scoringWords(said));
  const chars = charErrors([reference], said);
  return {
    wer: words.length ? wordEdits / words.length : null,
    cer: chars.length ? chars.errors / chars.length : null,
    edits: wordEdits,
    words: words.length,
    charEdits: chars.errors,
    chars: chars.length,
    foreignSegments,
    foreignInterims,
    languageMismatches: rows.filter((row) => row.languageMismatch).length,
    rows,
  };
}
