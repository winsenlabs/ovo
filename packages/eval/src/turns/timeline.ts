/**
 * Wave 13 (T2): a live call as the turn detector heard it, rebuilt from its engine events: every
 * transcript Scribe sent (interims and finals, at the time the engine got them), the agent's speech
 * (start and stop of each line, its kind and text), and the VAD's start and stop. The VAD comes from
 * the caller's own audio where the call has it (calls 7 and 8, corpus.ts `withAudio`), else it is
 * modelled from the live turns as plugin-turns/tests/call-endpoints.ts does (calls 4 to 6).
 *
 * Times are ms from the call's first engine event.
 */
export type TimelineEvent =
  | { at: number; type: 'transcript'; seg: string; text: string; final: boolean }
  | { at: number; type: 'vad.start' | 'vad.stop' }
  | {
      at: number;
      type: 'agent.start';
      epoch: number;
      kind: string;
      text: string;
      question: boolean;
      filler: boolean;
    }
  | { at: number; type: 'agent.stop'; epoch: number; kind: string };

export interface LiveTurn {
  id: string;
  startedAt: number;
  endAt: number;
  text: string | null;
  rule: string | null;
  endpointMs: number | null;
  reset: string | null;
}

export interface AgentLine {
  start: number;
  stop: number;
  kind: string;
  text: string;
  state: 'completed' | 'interrupted' | 'dropped';
}

export interface Timeline {
  call: string;
  label: string;
  durationMs: number;
  transcripts: Extract<TimelineEvent, { type: 'transcript' }>[];
  agent: AgentLine[];
  live: LiveTurn[];
  vad: {
    source: 'audio' | 'modelled';
    events: Extract<TimelineEvent, { type: 'vad.start' | 'vad.stop' }>[];
  };
  /** The caller audio (8 kHz) and where its first sample falls on the timeline. */
  audio?: { pcm: Int16Array; offsetMs: number };
}

interface EngineRow {
  type: string;
  payload: { atMs?: number; event?: Record<string, unknown> };
}

/** Parses an events export (JSON lines, or a JSON array) into its engine events, timed from t0. */
export function engineEvents(raw: string): { at: number; event: Record<string, unknown> }[] {
  const trimmed = raw.trim();
  const rows: EngineRow[] = trimmed.startsWith('[')
    ? JSON.parse(trimmed)
    : trimmed.split('\n').map((line) => JSON.parse(line));
  const engine = rows.filter((row) => row.type === 'engine.event' && row.payload.event);
  const t0 = engine[0]?.payload.atMs ?? 0;
  return engine.map((row) => ({ at: row.payload.atMs! - t0, event: row.payload.event! }));
}

/** The transcripts, the agent's lines and the live turns of an events export. */
export function fromEngineEvents(
  call: string,
  label: string,
  raw: string,
): Omit<Timeline, 'vad' | 'audio'> {
  const events = engineEvents(raw);
  const transcripts: Timeline['transcripts'] = [];
  const turns = new Map<string, LiveTurn>();
  const lines = new Map<string, Partial<AgentLine> & { text: string; kind: string }>();
  for (const { at, event } of events) {
    if (event.type === 'user.transcript')
      transcripts.push({
        at,
        type: 'transcript',
        seg: String(event.segmentId),
        text: String(event.text ?? ''),
        final: event.stability === 'final',
      });
    else if (event.type === 'user.turn') {
      const id = String(event.turnId);
      const turn = turns.get(id) ?? {
        id,
        startedAt: at,
        endAt: at,
        text: null,
        rule: null,
        endpointMs: null,
        reset: null,
      };
      if (event.phase === 'started') turn.startedAt = at;
      else {
        turn.endAt = at;
        turn.text = (event.text as string | undefined) ?? null;
        turn.rule = (event.endpointRule as string | undefined) ?? null;
        turn.endpointMs = (event.endpointMs as number | undefined) ?? null;
        turn.reset = (event.resetReason as string | undefined) ?? null;
      }
      turns.set(id, turn);
    } else if (event.type === 'speech') {
      const evidence = event.evidence as Record<string, unknown>;
      const id = String(evidence.segmentId);
      const line = lines.get(id) ?? {
        text: String(evidence.text ?? ''),
        kind: String(evidence.kind),
      };
      const phase = evidence.phase;
      if (phase === 'started') line.start ??= at;
      if (phase === 'completed' || phase === 'interrupted' || phase === 'dropped') {
        line.stop = at;
        line.state = phase;
      }
      lines.set(id, line);
    }
  }
  const agent = [...lines.values()]
    .filter((line): line is AgentLine => line.start !== undefined && line.stop !== undefined)
    .sort((a, b) => a.start - b.start);
  const live = [...turns.values()].filter((turn) => turn.id.startsWith('turn-'));
  const durationMs = (events.at(-1)?.at ?? 0) + 1000;
  return { call, label, durationMs, transcripts, agent, live };
}

/**
 * The agent's speaking intervals as the detector heard them (bot.started / bot.stopped): lines that
 * overlap or touch merge into one interval (the engine plays a reply's lines back to back under
 * one epoch), asking a question if any of its lines does, a filler while all of them are.
 */
export function agentEvents(agent: readonly AgentLine[]): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  let epoch = 0;
  let open: { stop: number; kind: string; filler: boolean; question: boolean } | undefined;
  for (const line of agent) {
    const filler = line.kind === 'acknowledgment';
    const question = /\?\s*$/.test(line.text);
    if (open && line.start <= open.stop + 50) {
      open.stop = Math.max(open.stop, line.stop);
      if ((open.filler && !filler) || (question && !open.question)) {
        open.filler &&= filler;
        open.question ||= question;
        out.push({
          at: line.start,
          type: 'agent.start',
          epoch,
          kind: filler ? open.kind : line.kind,
          text: line.text,
          question: open.question,
          filler: open.filler,
        });
      }
      continue;
    }
    if (open) out.push({ at: open.stop, type: 'agent.stop', epoch, kind: open.kind });
    epoch++;
    open = { stop: line.stop, kind: line.kind, filler, question };
    out.push({
      at: line.start,
      type: 'agent.start',
      epoch,
      kind: line.kind,
      text: line.text,
      question,
      filler,
    });
  }
  if (open) out.push({ at: open.stop, type: 'agent.stop', epoch, kind: open.kind });
  return out;
}

/** The VAD's stopMs, which the engine adds back to each endpoint. */
const HANGOVER_MS = 200;
/** A modelled VAD run starts this long before its turn's first words reached the engine. */
const VAD_LEAD_MS = 300;
/** A segment final inside a turn: the modelled pause before it, and the voice again after. */
const PAUSE_MS = 600;
const RESUME_MS = 250;

/**
 * The VAD modelled from the live turns (no audio): each turn's run from its start (or just before
 * its first words) to its VAD stop (its end, less its endpoint, plus the hangover), with a pause
 * before each segment final the caller went on after. As plugin-turns/tests/call-endpoints.ts.
 */
export function modelledVad(
  live: readonly LiveTurn[],
  transcripts: Timeline['transcripts'],
): Timeline['vad'] {
  const events: Timeline['vad']['events'] = [];
  let last = -Infinity;
  for (const turn of live) {
    if (turn.endpointMs === null || turn.reset) continue;
    const stop = turn.endAt - turn.endpointMs + HANGOVER_MS;
    const mine = transcripts.filter((t) => t.at > last && t.at <= turn.endAt);
    const first = mine[0];
    const start = Math.max(
      last + 20,
      Math.min(turn.startedAt, (first?.at ?? stop) - VAD_LEAD_MS, stop - VAD_LEAD_MS),
    );
    events.push({ at: start, type: 'vad.start' });
    for (const [index, entry] of mine.entries()) {
      const next = mine[index + 1];
      if (!entry.final || !next || entry.at >= stop) continue;
      if (entry.at - PAUSE_MS <= start || entry.at - RESUME_MS >= stop) continue;
      events.push({ at: entry.at - PAUSE_MS, type: 'vad.stop' });
      events.push({ at: entry.at - RESUME_MS, type: 'vad.start' });
    }
    events.push({ at: Math.max(stop, start + 20), type: 'vad.stop' });
    last = turn.endAt;
  }
  return { source: 'modelled', events };
}

/** All of a timeline's events in time order (VAD, transcripts, agent), stable for equal times. */
export function timelineEvents(timeline: Timeline): TimelineEvent[] {
  const order = { 'vad.start': 0, 'agent.stop': 1, 'agent.start': 2, transcript: 3, 'vad.stop': 4 };
  return [...timeline.vad.events, ...timeline.transcripts, ...agentEvents(timeline.agent)]
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        a.event.at - b.event.at || order[a.event.type] - order[b.event.type] || a.index - b.index,
    )
    .map(({ event }) => event);
}
