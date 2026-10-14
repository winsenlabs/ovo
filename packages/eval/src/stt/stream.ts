// Streams a call's caller utterances through one STT configuration the way a live call does:
// one session for the call, 20 ms frames of 8 kHz μ-law in real time, a host commit wherever the
// live VAD stopped (Scribe's manual strategy), digital silence between utterances (the carrier
// track's own gaps are exact silence).
import { MULAW_8K, type NetPort, type SpeechToText } from '../../../contracts/src/index.ts';
import { silence } from '../../../audio/src/index.ts';
import { adaptSpeechToText } from '../../../session-host/src/speech-adapters/stt-format.ts';

export const FRAME_MS = 20;

export interface StreamUtterance {
  id: string;
  /** 8 kHz μ-law, a whole number of 20 ms frames: lead-in, the speech, nothing after it. */
  audio: Uint8Array;
  /**
   * When the host commits (forceEndpoint), ms from the window start, ascending; past the audio's
   * end means during the silence after it.
   */
  commitAtMs: readonly number[];
  /** Where the speech ends in `audio`, ms; time to final is measured from here. */
  speechEndMs: number;
}

export interface StreamEvent {
  /** Session time: ms since the first frame was sent. */
  atMs: number;
  kind: 'partial' | 'final';
  segmentId: string;
  text: string;
}

export interface UtteranceRecording {
  id: string;
  /** Session times of the utterance's first frame and of its speech end. */
  startMs: number;
  speechEndMs: number;
  commitsAtMs: number[];
  events: StreamEvent[];
  /** Languages the provider reported while this utterance was current. */
  languages: string[];
}

export interface StreamRecording {
  config: string;
  call: string;
  model: string;
  language: string;
  recordedAt: string;
  /** Audio sent, including the silence between utterances. */
  streamedMs: number;
  /** Socket open to close, for providers that bill the session. */
  sessionMs: number;
  usage: { unit: string; quantity: string; state: string }[];
  utterances: UtteranceRecording[];
  error?: string;
}

export interface StreamOptions {
  config: string;
  call: string;
  model: string;
  language: string;
  stt: SpeechToText;
  utterances: readonly StreamUtterance[];
  /** Stop waiting for an utterance's final this long after its speech ends. */
  maxWaitMs?: number;
  /** Keep listening this long after a final, for a trailing one. */
  graceMs?: number;
  /**
   * Real-time pacing (the default). Off, session time is the audio sent and each frame yields to
   * the event loop once, so a scripted network answers between frames: for tests.
   */
  pace?: boolean;
  /** Raw provider messages, from `tapNet`, to find reported languages. */
  tap?: { onMessage?: (raw: string) => void };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The language a provider message reports: Scribe, AssemblyAI and Sarvam `language_code`, Deepgram `languages`. */
export function reportedLanguage(raw: string): string | undefined {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    // swallow-ok: binary or non-JSON frames carry no language.
    return undefined;
  }
  if (!message || typeof message !== 'object') return undefined;
  const value = message as Record<string, unknown>;
  if (typeof value.language_code === 'string' && value.language_code) return value.language_code;
  const data = value.data as Record<string, unknown> | undefined;
  if (data && typeof data.language_code === 'string' && data.language_code)
    return data.language_code;
  const alternative = ((value.channel as { alternatives?: { languages?: unknown }[] } | undefined)
    ?.alternatives ?? [])[0];
  const languages = alternative?.languages;
  return Array.isArray(languages) && typeof languages[0] === 'string' ? languages[0] : undefined;
}

/** A NetPort that also hands every text frame its sockets receive to `onMessage`. */
export function tapNet(net: NetPort, onMessage: (raw: string) => void): NetPort {
  return {
    fetch: (url, init) => net.fetch(url, init),
    websocket(url, opts) {
      const socket = net.websocket(url, opts);
      socket.on('message', (data, binary) => {
        if (!binary) onMessage(typeof data === 'string' ? data : new TextDecoder().decode(data));
      });
      return socket;
    },
  };
}

/**
 * Records what the configuration returns for each utterance, in order, on one session. A session
 * failure is recorded and ends the run; the utterances not reached have no recording.
 */
export async function streamCall(options: StreamOptions): Promise<StreamRecording> {
  const pace = options.pace !== false;
  const maxWaitMs = options.maxWaitMs ?? 2_500;
  const graceMs = options.graceMs ?? 300;
  const stt = adaptSpeechToText(options.stt);
  const commits = Boolean(options.stt.capabilities.forceEndpoint);
  const utterances: UtteranceRecording[] = [];
  const usage: StreamRecording['usage'] = [];
  const controller = new AbortController();
  let current: UtteranceRecording | undefined;
  let startedAt = performance.now();
  let lastFinalAt = -Infinity;
  let sentFrames = 0;
  const elapsed = () => (pace ? performance.now() - startedAt : sentFrames * FRAME_MS);
  const quietFrame = silence(MULAW_8K, FRAME_MS);
  const recording = (error?: unknown): StreamRecording => ({
    config: options.config,
    call: options.call,
    model: options.model,
    language: options.language,
    recordedAt: new Date().toISOString(),
    streamedMs: sentFrames * FRAME_MS,
    sessionMs: Math.round(elapsed()),
    usage,
    utterances,
    ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
  });
  if (options.tap)
    options.tap.onMessage = (raw) => {
      const language = reportedLanguage(raw);
      if (language && current) current.languages.push(language);
    };
  let session: Awaited<ReturnType<SpeechToText['start']>>;
  try {
    session = await stt.start({
      sessionId: `stt-bakeoff-${options.config}-${options.call}`,
      format: MULAW_8K,
      language: options.language,
      signal: controller.signal,
      onEvent(event) {
        if (event.type !== 'transcript' || !current) return;
        const kind = event.segment.stability === 'final' ? 'final' : 'partial';
        const atMs = Math.round(elapsed());
        current.events.push({
          atMs,
          kind,
          segmentId: event.segment.segmentId,
          text: event.segment.text,
        });
        if (kind === 'final' && event.segment.text.trim()) lastFinalAt = atMs;
      },
      onUsage: (meter) =>
        usage.push({ unit: meter.unit, quantity: meter.quantity, state: meter.state }),
    });
  } catch (error) {
    return recording(error);
  }
  startedAt = performance.now();
  const send = async (frame: Uint8Array) => {
    await session.write(frame);
    sentFrames += 1;
    // Scheduled against the session start, so a slow write never makes the stream drift late.
    await sleep(pace ? Math.max(0, sentFrames * FRAME_MS - elapsed()) : 0);
  };
  try {
    for (const utterance of options.utterances) {
      const frameBytes = (8000 * FRAME_MS) / 1000;
      current = {
        id: utterance.id,
        startMs: Math.round(elapsed()),
        speechEndMs: NaN,
        commitsAtMs: [],
        events: [],
        languages: [],
      };
      utterances.push(current);
      const pending = [...utterance.commitAtMs];
      let position = 0;
      const step = async (frame: Uint8Array) => {
        await send(frame);
        position += FRAME_MS;
        if (Number.isNaN(current!.speechEndMs) && position >= utterance.speechEndMs)
          current!.speechEndMs = Math.round(elapsed());
        while (pending.length && pending[0]! <= position) {
          pending.shift();
          if (!commits) continue;
          current!.commitsAtMs.push(Math.round(elapsed()));
          await session.forceEndpoint?.();
        }
      };
      const frames = Math.floor(utterance.audio.byteLength / frameBytes);
      for (let index = 0; index < frames; index += 1)
        await step(utterance.audio.subarray(index * frameBytes, (index + 1) * frameBytes));
      for (;;) {
        await step(quietFrame);
        const after = commits
          ? (current.commitsAtMs.at(-1) ?? current.speechEndMs)
          : current.speechEndMs;
        const answered = lastFinalAt >= after && elapsed() - lastFinalAt >= graceMs;
        const waited = elapsed() - current.speechEndMs;
        if ((!pending.length && answered) || waited >= maxWaitMs) break;
      }
    }
    // A final the finish flushes still belongs to the last utterance.
    await Promise.race([session.finish(), sleep(3_000)]);
    return recording();
  } catch (error) {
    return recording(error);
  } finally {
    await session.cancel('bake-off done').catch(() => undefined); // swallow-ok: already settled.
    controller.abort();
  }
}
