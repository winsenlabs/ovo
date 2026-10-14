// A corpus directory: per call `<call>-events.jsonl` (or `.json`), `<call>-turns.json(l)`,
// `<call>-caller.wav`, `<call>-alignment.json`, `<call>-manifest.json`, `<call>-vad.json` (a VAD
// trace, `eval:calls slim`), and `gold/<call>.json`. Every file but one of the events or turns is
// optional. An optional `corpus.json` names the calls and overrides per call (docs/eval/README.md).
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { callEvents, parseExport, type CallEvents } from '../log/export.ts';
import { parseGold, type Gold } from './gold.ts';
import { MAYA, profileFrom, type AgentProfile } from './profile.ts';
import { estimateOffset, parseVadTrace, traceFromPcm, type VadTrace } from './vad-trace.ts';
import { decodeWav } from './wav.ts';

/** A per-turn summary row (`/v1/calls/:id/turns`), for calls whose events were not exported. */
export interface TurnSummary {
  turnId: string;
  input: string;
  userText: string | null;
  agentText: string | null;
  startedAt: string;
  endpointMs: number | null;
  endpointRule?: string | null;
  firstAudioMs: number | null;
  firstSegmentMs: number | null;
  llmCalls: number;
  searchCalls: number;
  interrupted: boolean;
}

export interface CorpusCall {
  name: string;
  label?: string;
  notes: string[];
  events?: CallEvents;
  summaries?: TurnSummary[];
  /** The caller track, 8 kHz mono, when the call has one. */
  audioPath?: string;
  /** Call time = caller-track time + audioOffsetMs. */
  audioOffsetMs?: number;
  vad?: VadTrace;
  gold?: Gold;
  profile: AgentProfile;
}

interface CorpusFile {
  description?: string;
  profile?: unknown;
  calls?: Record<
    string,
    { label?: string; notes?: string[]; audioOffsetMs?: number; profile?: unknown; skip?: boolean }
  >;
}

const NAME = /^(.+?)-(events|turns)\.(jsonl|json)$/;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function first(dir: string, names: string[]): Promise<string | undefined> {
  return names.map((name) => join(dir, name)).find((path) => existsSync(path));
}

function summariesOf(text: string): TurnSummary[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('{"callId"') || trimmed.startsWith('{\n'))
    return (JSON.parse(trimmed) as { turns: TurnSummary[] }).turns;
  if (trimmed.startsWith('[')) return JSON.parse(trimmed) as TurnSummary[];
  return trimmed
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as TurnSummary);
}

/** The caller track's start on the call timeline, from the recording manifest. */
function manifestOffset(manifest: unknown, startedAt: number): number | undefined {
  const value = manifest as {
    createdAt?: string;
    segments?: { track?: string; startMs?: number }[];
  };
  const inbound = value?.segments?.find((segment) => segment.track === 'inbound');
  if (!value?.createdAt || inbound?.startMs === undefined) return undefined;
  return Math.round(Date.parse(value.createdAt) + inbound.startMs - startedAt);
}

export async function loadCall(
  dir: string,
  name: string,
  overrides: NonNullable<CorpusFile['calls']>[string] = {},
  profile: AgentProfile = MAYA,
): Promise<CorpusCall> {
  const call: CorpusCall = {
    name,
    notes: [...(overrides.notes ?? [])],
    profile: overrides.profile ? profileFrom(overrides.profile, profile) : profile,
    ...(overrides.label ? { label: overrides.label } : {}),
  };
  const events = await first(dir, [`${name}-events.jsonl`, `${name}-events.json`]);
  if (events) call.events = callEvents(parseExport(await readFile(events, 'utf8')));
  const turns = await first(dir, [`${name}-turns.json`, `${name}-turns.jsonl`]);
  if (turns) call.summaries = summariesOf(await readFile(turns, 'utf8'));
  if (!call.events && !call.summaries)
    throw new Error(`${name}: no events or turns file in ${dir}`);
  if (!call.events) call.notes.push('turn summaries only: no transcript stream to replay');
  const gold = await first(dir, [join('gold', `${name}.json`)]);
  if (gold) call.gold = parseGold(await readJson(gold));
  const vad = await first(dir, [`${name}-vad.json`]);
  if (vad) call.vad = parseVadTrace(await readJson(vad));
  const audio = await first(dir, [`${name}-caller.wav`]);
  if (audio) call.audioPath = audio;
  const manifest = await first(dir, [`${name}-manifest.json`]);
  const startedAt = call.events?.startedAt;
  const fromManifest =
    manifest && startedAt !== undefined
      ? manifestOffset(await readJson(manifest), startedAt)
      : undefined;
  // The replay delivers the track on the offset its VAD trace was read with. The gold file's own
  // offset (the STT lane's alignment, stamped by speech onset rather than by the frame that ends
  // the VAD's debounce) is only a fallback: gold times are already on the call timeline.
  const given = overrides.audioOffsetMs ?? call.vad?.offsetMs;
  if (given !== undefined) call.audioOffsetMs = given;
  else if (audio && call.events) {
    // The recording's own alignment is not waveform-synchronized: read the offset off the audio.
    const trace = traceFromPcm(
      decodeWav(new Uint8Array(await readFile(audio))),
      0,
      call.profile.vad,
    );
    const starts = call.events.engine
      .filter(({ event }) => event.type === 'user.turn' && event.phase === 'started')
      .map(({ atMs }) => atMs);
    const estimate = estimateOffset(trace, starts);
    call.audioOffsetMs = estimate?.offsetMs ?? call.gold?.offsetMs ?? fromManifest ?? 0;
    call.vad = { ...trace, offsetMs: call.audioOffsetMs };
    call.notes.push(
      estimate
        ? `caller track offset ${estimate.offsetMs} ms, from ${estimate.agreeing} of ${starts.length} turn starts`
        : `caller track offset ${call.audioOffsetMs} ms from the gold file or the recording manifest (turn starts disagreed)`,
    );
  } else {
    const fallback = call.gold?.offsetMs ?? fromManifest;
    if (fallback !== undefined) call.audioOffsetMs = fallback;
  }
  return call;
}

/** Every call in `dir` (or those `only` names), in name order. */
export async function loadCorpus(dir: string, only?: readonly string[]): Promise<CorpusCall[]> {
  const file = join(dir, 'corpus.json');
  const corpus: CorpusFile = existsSync(file) ? ((await readJson(file)) as CorpusFile) : {};
  const profile = corpus.profile ? profileFrom(corpus.profile) : MAYA;
  const names = new Set<string>(Object.keys(corpus.calls ?? {}));
  for (const entry of await readdir(dir)) {
    const match = NAME.exec(entry);
    if (match) names.add(match[1]!);
  }
  const wanted = [...names]
    .filter((name) => !corpus.calls?.[name]?.skip)
    .filter((name) => !only?.length || only.includes(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const missing = only?.filter((name) => !names.has(name)) ?? [];
  if (missing.length) throw new Error(`no such call in ${dir}: ${missing.join(', ')}`);
  return Promise.all(wanted.map((name) => loadCall(dir, name, corpus.calls?.[name], profile)));
}
