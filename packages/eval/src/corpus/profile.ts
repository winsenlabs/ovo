// The agent a corpus call ran: what a replay needs to rebuild it (its config, turn detector row and
// VAD row), the lines the platform adds to a reply, and the lines the scorecard counts as canned.
// The built-in profile is Maya, the founder's Europe-trip test agent, as Waves 10–12 ran her: her
// agent config lives in the live database, so `message` here is a stand-in (replays answer from
// the call's own recorded replies, never from the prompt).
import type { ActivityAnnouncement } from '@winsendotai/ovo-plugin-kit';

export interface CannedLine {
  category: 'clarification' | 'say-again' | 'uncertainty';
  pattern: RegExp;
}

export interface AgentProfile {
  name: string;
  /** AgentConfig input for the behaviour. */
  agent: Record<string, unknown>;
  /** The turn detector row (`@winsendotai/ovo-turn-detector-default` config). */
  detector: Record<string, unknown>;
  /** The energy VAD row. */
  vad: Record<string, unknown>;
  /** The languages callers speak (BCP-47 bases): other languages are misdetections. */
  languages: string[];
  /** Lines the platform says that are not the model's: fillers, the search announcement. */
  fillers: string[];
  search: ActivityAnnouncement;
  /** Offers of more the reply cap appends ("Want more detail?"). */
  offers: string[];
  /** Platform lines that replaced the model's uncertainty line on a live call. */
  replaced: string[];
  /** The end-call confirmation the platform says for the model's `end_call`. */
  askToEnd?: string;
  canned: CannedLine[];
  /** Synthesis timing for replays: first byte, and speaking time per character. */
  tts: { firstByteMs: number; msPerChar: number };
}

const UNSURE = "I'm not completely sure about that. Want me to look it up?";
const GREETING = "Hi! I'm Maya, your Europe trip companion. Where are you thinking of going?";

export const DEFAULT_CANNED: CannedLine[] = [
  { category: 'clarification', pattern: /please clarify|could you finish your question/i },
  {
    category: 'say-again',
    pattern: /say that again|didn'?t catch|put it another way|could you repeat|say it again/i,
  },
  {
    category: 'uncertainty',
    pattern:
      /not completely sure about that|do not have that information|i'?m not sure about that/i,
  },
];

export const MAYA: AgentProfile = {
  name: 'maya',
  agent: {
    name: 'Maya',
    mode: 'agent',
    language: 'en-IN',
    message:
      'You are Maya, a friendly Europe trip companion on a phone call. Answer briefly, in short spoken sentences.',
    uncertainty: UNSURE,
    opening: { lines: [GREETING] },
    ending: { llmTool: true },
  },
  // The default detector with Maya's own fields (plugin-turns tests/replay.ts MAYA, less the
  // `commit.silenceMs` 450 the Wave 8 preset removed).
  detector: {
    minWordsWhileBotSpeaking: 3,
    backchannels: ['uh huh', 'mm hmm', 'yeah', 'yes', 'ok', 'okay', 'right', 'haan', 'hmm', 'ji'],
    filler: { lines: ['One moment.'], afterMs: 1500 },
  },
  vad: {},
  languages: ['en', 'hi'],
  fillers: ['One moment.', 'Let me look that up.', 'Still checking, one moment.'],
  search: {
    line: 'Let me look that up.',
    stillLine: 'Still checking, one moment.',
    stillAfterMs: 2500,
  },
  offers: [
    'Want more detail?',
    'Want to hear more?',
    'Would you like more on that?',
    'Interested in more detail?',
  ],
  replaced: [
    'Please clarify your question.',
    'Sorry, could you say that again?',
    "Sorry, I still didn't catch that. Could you put it another way?",
  ],
  askToEnd: 'Shall I end the call?',
  canned: DEFAULT_CANNED,
  // Calls 7 and 8: ElevenLabs first bytes 140–360 ms; Maya speaks about 60 ms a character.
  tts: { firstByteMs: 200, msPerChar: 62 },
};

/** A profile file (JSON) over the built-in one: patterns are strings there. */
export function profileFrom(value: unknown, base: AgentProfile = MAYA): AgentProfile {
  if (!value || typeof value !== 'object') return base;
  const raw = value as Partial<Omit<AgentProfile, 'canned'>> & {
    canned?: { category: CannedLine['category']; pattern: string }[];
  };
  return {
    ...base,
    ...raw,
    canned: raw.canned
      ? raw.canned.map((line) => ({
          category: line.category,
          pattern: new RegExp(line.pattern, 'i'),
        }))
      : base.canned,
  } as AgentProfile;
}

/** The category of a canned line, or undefined. */
export function cannedCategory(
  profile: AgentProfile,
  text: string,
): CannedLine['category'] | undefined {
  return profile.canned.find((line) => line.pattern.test(text))?.category;
}

/** A line the platform adds (filler, search announcement, end-call confirmation). */
export function isPlatformLine(profile: AgentProfile, text: string): boolean {
  const trimmed = text.trim();
  return profile.fillers.includes(trimmed) || trimmed === profile.askToEnd;
}
