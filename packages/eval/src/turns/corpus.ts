import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { call4 } from '../replay-kit/call4-timeline.ts';
import { alignAudio, readWav, vadTransitions } from './audio.ts';
import {
  fromEngineEvents,
  modelledVad,
  type AgentLine,
  type LiveTurn,
  type Timeline,
} from './timeline.ts';

/**
 * The turn bake-off corpus (Wave 13): Maya's live calls 4 to 8, as compact JSON committed beside
 * this file (corpus/callN.json: transcripts, agent lines, live turns), built from the raw exports in
 * ~/work/ovo-waves by `buildCompact` (corpus-build.ts). Calls 7 and 8 also have the caller's audio,
 * read from the corpus directory when it is there (`withAudio`).
 */
export interface CompactCall {
  call: string;
  label: string;
  source: string;
  durationMs: number;
  transcripts: Timeline['transcripts'];
  agent: AgentLine[];
  live: LiveTurn[];
  /** The caller audio file in the corpus directory, when the call has one. */
  audio?: string;
  /** The VAD as rebuilt with the call (call 4), used instead of modelling it from the turns. */
  vad?: Timeline['vad']['events'];
}

export const CALLS = ['call4', 'call5', 'call6', 'call7', 'call8'] as const;
export type CallName = (typeof CALLS)[number];

export function loadCompact(name: CallName): CompactCall {
  return JSON.parse(readFileSync(new URL(`./corpus/${name}.json`, import.meta.url), 'utf8'));
}

/** A call's timeline with its VAD modelled from the live turns (no audio needed). */
export function transcriptTimeline(compact: CompactCall): Timeline {
  return {
    call: compact.call,
    label: compact.label,
    durationMs: compact.durationMs,
    transcripts: compact.transcripts,
    agent: compact.agent,
    live: compact.live,
    vad: compact.vad
      ? { source: 'modelled', events: compact.vad }
      : modelledVad(compact.live, compact.transcripts),
  };
}

/**
 * A call's timeline with the VAD run on its caller audio (the production energy VAD), the audio
 * aligned to the events (`alignAudio`). Undefined when the call has no audio or the file is absent.
 */
export function withAudio(
  compact: CompactCall,
  corpusDir: string,
): (Timeline & { alignment: ReturnType<typeof alignAudio> }) | undefined {
  if (!compact.audio) return undefined;
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(corpusDir, compact.audio));
  } catch {
    return undefined;
  }
  const { pcm, sampleRate } = readWav(bytes);
  if (sampleRate !== 8000) throw new Error(`${compact.audio}: expected 8 kHz`);
  const transitions = vadTransitions(pcm);
  const alignment = alignAudio(
    transitions.filter((t) => t.type === 'vad.start').map((t) => t.at),
    compact.live,
    compact.transcripts,
  );
  return {
    ...transcriptTimeline(compact),
    vad: {
      source: 'audio',
      events: transitions.map((t) => ({ ...t, at: t.at + alignment.offsetMs })),
    },
    audio: { pcm, offsetMs: alignment.offsetMs },
    alignment,
  };
}

/** Builds a compact call from an engine events export (calls 5 to 8). */
export function buildCompact(
  call: string,
  label: string,
  source: string,
  raw: string,
  audio?: string,
): CompactCall {
  const timeline = fromEngineEvents(call, label, raw);
  return { ...timeline, source, ...(audio ? { audio } : {}) };
}

/**
 * Call 4 (e8a43f65) has only turn summaries: its timeline is plugin-turns' rebuilt one
 * (replay-kit/call4-timeline.ts, measured where the summaries allow and modelled, marked so, where they
 * do not), with each host-commit answer placed where it was measured (`FINALS`).
 */
const CALL4_FINALS = [22_969, 42_172, 45_975, 67_933, 72_640, 75_589, 92_193];
const CALL4_STOPS = [22_177, 41_917, 44_178, 67_077, 71_857, 74_777, 91_457];
const CALL4_ENDPOINTS = [993, 456, 1797, 1056, 984, 1012, 936];

export function buildCall4(): CompactCall {
  const steps = call4();
  const said: { at: number; text: string; final: boolean }[] = [];
  const agent: AgentLine[] = [];
  let open: AgentLine | undefined;
  let commits = 0;
  for (const step of [...steps].sort((a, b) => a.at - b.at)) {
    if ('interim' in step) said.push({ at: step.at, text: step.interim, final: false });
    else if ('final' in step) said.push({ at: step.at, text: step.final, final: true });
    else if ('commit' in step) {
      // Turn 2's final came before any commit (its own step): the commits answer the others.
      if (commits === 1) commits++;
      said.push({ at: CALL4_FINALS[commits++]!, text: step.commit, final: true });
    } else if ('agent' in step) {
      if (step.agent === 'stop') {
        if (open) agent.push({ ...open, stop: step.at, state: 'completed' });
        open = undefined;
      } else if (!open)
        open = {
          start: step.at,
          stop: step.at,
          kind: 'response',
          text: step.agent === 'question' ? 'What dates are you considering?' : '…',
          state: 'completed',
        };
      else if (step.agent === 'question')
        open.text = `${open.text} What dates are you considering?`;
    }
  }
  // Scribe's segments: each final closes one.
  let seg = 0;
  const transcripts: Timeline['transcripts'] = said
    .sort((a, b) => a.at - b.at)
    .map((entry) => {
      const event = {
        at: entry.at,
        type: 'transcript' as const,
        seg: String(seg),
        text: entry.text,
        final: entry.final,
      };
      if (entry.final) seg++;
      return event;
    });
  const live: LiveTurn[] = CALL4_FINALS.map((at, index) => ({
    id: `turn-${index + 1}`,
    startedAt:
      steps.find(
        (s) =>
          'vad' in s &&
          s.vad === 'vad.start' &&
          s.at < CALL4_STOPS[index]! &&
          s.at > (CALL4_STOPS[index - 1] ?? 0),
      )?.at ?? CALL4_STOPS[index]! - 1000,
    endAt: CALL4_STOPS[index]! + CALL4_ENDPOINTS[index]! - 200,
    text: transcripts.find((t) => t.final && t.at === at)?.text ?? null,
    rule: null,
    endpointMs: CALL4_ENDPOINTS[index]!,
    reset: null,
  }));
  return {
    call: 'e8a43f65',
    label: 'call 4',
    source:
      'Maya call e8a43f65 (2026-10-12): plugin-turns tests/call4-timeline.ts (rebuilt from turn summaries)',
    durationMs: 100_000,
    transcripts,
    agent,
    live,
    vad: steps
      .flatMap((step) => ('vad' in step ? [{ at: step.at, type: step.vad }] : []))
      .sort((a, b) => a.at - b.at),
  };
}
