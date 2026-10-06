// STT-10 bake-off data: the corpus of recorded utterances and what each provider returned for them.

export const PROVIDERS = ['scribe', 'assemblyai', 'sarvam'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface CorpusUtterance {
  id: string;
  /** The session language the agent would use: `en-IN` for Indian English, `hi-IN` for Hinglish. */
  language: string;
  style: 'indian-english' | 'hinglish' | 'hindi';
  /** What the caller said, as a careful human transcriber writes it. */
  reference: string;
  /** Equally correct transcripts, such as the Devanagari spelling of Hindi words. */
  accept?: string[];
  /** A mono WAV next to corpus.json (8 kHz mu-law, or 16-bit PCM at 8 or 16 kHz). Live mode only. */
  audio?: string;
}

export interface Corpus {
  /** True when the references and recordings are made up for tests: the report then measures nothing. */
  synthetic?: boolean;
  description?: string;
  utterances: CorpusUtterance[];
}

/** One transcript event, timed from the first audio byte sent (audio is paced in real time). */
export interface RecordedEvent {
  atMs: number;
  kind: 'partial' | 'final';
  segmentId: string;
  text: string;
}

/** What one provider returned for one utterance, live or replayed. */
export interface Recording {
  provider: ProviderId;
  model: string;
  utteranceId: string;
  language: string;
  /** When the last caller audio frame was sent; latency to the final is measured from here. */
  audioEndMs: number;
  events: RecordedEvent[];
  usage: { unit: string; quantity: string; state: string }[];
  /** Why the session failed, when it did; its transcript counts as empty. */
  error?: string;
  recordedAt: string;
  synthetic?: boolean;
}

export interface PriceEntry {
  unit: string;
  currency: 'USD' | 'INR';
  perHour: number;
  source: string;
  retrieved: string;
  note?: string;
}

export type PriceTable = Partial<Record<ProviderId, PriceEntry>>;

export function isProvider(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

/** Checks a corpus file's shape, so a hand-edited one fails with the field at fault. */
export function parseCorpus(value: unknown): Corpus {
  const corpus = value as Corpus;
  if (!corpus || !Array.isArray(corpus.utterances) || !corpus.utterances.length)
    throw new Error('corpus.json needs a non-empty `utterances` array');
  const ids = new Set<string>();
  for (const [index, utterance] of corpus.utterances.entries()) {
    const at = `utterances[${index}]`;
    if (typeof utterance.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(utterance.id))
      throw new Error(`${at}.id must be lowercase letters, digits, - or _`);
    if (ids.has(utterance.id)) throw new Error(`${at}.id ${utterance.id} is a duplicate`);
    ids.add(utterance.id);
    if (typeof utterance.reference !== 'string' || !utterance.reference.trim())
      throw new Error(`${at}.reference is empty`);
    if (typeof utterance.language !== 'string') throw new Error(`${at}.language is missing`);
    if (!['indian-english', 'hinglish', 'hindi'].includes(utterance.style))
      throw new Error(`${at}.style must be indian-english, hinglish or hindi`);
  }
  return corpus;
}
