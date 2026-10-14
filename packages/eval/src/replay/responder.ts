// The LLM of a replay, deterministic and free: it answers each request with what the model said
// live for the caller's words, found by word overlap and the call's turn order, after the time the
// live reply took. A request that matches no live turn gets the next live reply in order, and once
// those run out a short neutral reply. A live turn that searched searches again: its search line is
// announced 600 ms in, as the provider's web search did. The words the platform added live (fillers,
// the search line, offers of more, canned replacements) are taken off first: the behaviour adds
// its own (calls-reply-replay.test.ts in plugin-voice did the same for calls 4–7).
import type { Inference, InferenceRequest, InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import type { InferenceActivity } from '@winsendotai/ovo-plugin-kit';
// Not in the plugin's public index; the eval kind may reach into a package's source.
import { unclearForSearch } from '../../../plugin-llm-openai/src/search-voice.ts';
import type { AgentProfile } from '../corpus/profile.ts';
import { scoringWords } from '../score/hinglish.ts';
import { answerLines, isFiller } from '../score/replies.ts';
import { answeredTurns } from '../score/segmentation.ts';
import type { CallTimeline } from '../timeline.ts';

export interface LiveReply {
  turnId: string;
  caller: string;
  /** The model's words, or an `end_call` goodbye. */
  text?: string;
  goodbye?: string;
  searched: boolean;
  /** From the request that answered live to its first reply line (compose time). */
  latencyMs: number;
}

const GOODBYE = /\bgoodbye\b|\bbye\b|have a (?:wonderful|lovely|great|safe) trip/i;
const SEARCH_AT_MS = 600;

/** What the model said live for each answered turn. */
export function liveReplies(timeline: CallTimeline, profile: AgentProfile): LiveReply[] {
  const answers = answerLines(profile, timeline);
  return answeredTurns(timeline.turns).flatMap((turn): LiveReply[] => {
    const lines = timeline.agent.filter((line) => line.turnId === turn.turnId);
    const own = answers.filter((line) => line.turnId === turn.turnId);
    if (!own.length) return [];
    let text = own.map((line) => line.text.trim()).join(' ');
    for (const offer of profile.offers)
      if (text.endsWith(` ${offer}`)) text = text.slice(0, -offer.length).trim();
    if (profile.replaced.includes(text)) text = String(profile.agent.uncertainty ?? text);
    const searched = lines.some(
      (line) => isFiller(profile, line) && line.text === profile.search.line,
    );
    // Compose time: from the request that answered (the last sent before the first line) to it.
    const first = own[0]!.generatedAtMs;
    const request = timeline.llm.filter((entry) => entry.atMs <= first).at(-1);
    const since = request?.atMs ?? turn.endedAtMs ?? first;
    const latencyMs = Math.min(8000, Math.max(300, first - since));
    const said = text === profile.askToEnd || GOODBYE.test(text) ? { goodbye: text } : { text };
    return [{ turnId: turn.turnId, caller: turn.text ?? '', ...said, searched, latencyMs }];
  });
}

/**
 * How well a request's words fit a live turn's: the turn's words ending the request (one that merged
 * earlier words in ahead of them, AGT-10), or the request's words all in the turn (one asked ahead on
 * the caller's partial words, LAT-3).
 */
function fit(asked: readonly string[], said: readonly string[]): number {
  if (!asked.length || !said.length) return 0;
  const tail = new Set(asked.slice(-said.length));
  const inSaid = new Set(said);
  const ending = said.filter((word) => tail.has(word)).length / said.length;
  const precision = asked.filter((word) => inSaid.has(word)).length / asked.length;
  return Math.max(ending, 0.9 * precision);
}

export interface RecordedResponder extends Inference {
  observeActivity(listener: (activity: InferenceActivity) => void): () => void;
  /** Each request: the live turn that answered it, or `unmatched`. */
  readonly requests: { atMs: number; input: string; answeredBy: string }[];
}

/**
 * A live LLM with its requests recorded as the recorded responder records its own (answered by
 * `live`), so a live-LLM run is scored on the requests the engine actually made.
 */
export function recordingInference(
  inner: Inference,
  now: () => number,
): Inference & { readonly requests: RecordedResponder['requests'] } {
  const requests: RecordedResponder['requests'] = [];
  const recorded =
    (method: (request: InferenceRequest) => unknown) => (request: InferenceRequest) => {
      requests.push({ atMs: now(), input: request.input, answeredBy: 'live' });
      return method.call(inner, request);
    };
  // A proxy, not a copy: the port's other members (activity observers, provider tools) stay its own.
  return new Proxy(inner, {
    get(target, key) {
      if (key === 'requests') return requests;
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (key === 'generate' || key === 'stream')
        return recorded(value as (request: InferenceRequest) => unknown);
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  }) as Inference & { readonly requests: RecordedResponder['requests'] };
}

export function recordedResponder(
  replies: readonly LiveReply[],
  profile: AgentProfile,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  now: () => number,
): RecordedResponder {
  const listeners = new Set<(activity: InferenceActivity) => void>();
  const requests: RecordedResponder['requests'] = [];
  const callerWords = replies.map((reply) => scoringWords(reply.caller));
  let cursor = -1;
  let ids = 0;
  const pick = (input: string): LiveReply | undefined => {
    const asked = scoringWords(input);
    let best = -1;
    let bestScore = 0;
    replies.forEach((reply, index) => {
      // The best fit near the call's order; among equals the later turn (a merged request answers
      // its newest words). A goodbye ends the replay, so only the next few turns may give it.
      if (reply.goodbye !== undefined && index > cursor + 2) return;
      const away = Math.max(0, Math.abs(index - (cursor + 1)) - 1);
      const score = fit(asked, callerWords[index]!) - 0.05 * away;
      if (score >= bestScore && score > 0) [best, bestScore] = [index, score];
    });
    if (best < 0 || bestScore < 0.5) best = cursor + 1 < replies.length ? cursor + 1 : -1;
    if (best >= 0) cursor = Math.max(cursor, best);
    return replies[best];
  };
  // As the OpenAI plugin decides (skipUnclearInput): no web search for words that ask nothing.
  const sends = (request: Omit<InferenceRequest, 'signal'>) =>
    request.providerTools === true ||
    (request.providerTools !== false && !unclearForSearch(request));
  return {
    provider: 'eval-recorded',
    model: 'recorded',
    requests,
    generate: () => Promise.reject(new Error('the recorded responder only streams')),
    async *stream(request): AsyncIterable<InferenceStreamEvent> {
      const reply = pick(request.input);
      requests.push({
        atMs: now(),
        input: request.input,
        answeredBy: reply?.turnId ?? 'unmatched',
      });
      const searches = Boolean(reply?.searched && sends(request));
      let waited = 0;
      if (searches) {
        await sleep(SEARCH_AT_MS, request.signal);
        if (request.signal.aborted) return;
        waited = SEARCH_AT_MS;
        const started = {
          phase: 'started' as const,
          tool: 'web_search',
          id: `ws-${++ids}`,
          atMs: now(),
        };
        for (const listener of listeners)
          listener({ ...started, signal: request.signal, announce: profile.search });
      }
      await sleep(Math.max(0, (reply?.latencyMs ?? 1200) - waited), request.signal);
      if (request.signal.aborted) return;
      if (reply?.goodbye !== undefined) {
        yield {
          kind: 'tool',
          toolId: 'end_call',
          input: { goodbye: reply.goodbye, reason: 'replayed' },
        };
      } else {
        const text = reply?.text ?? 'Sure, I can help with that.';
        for (const delta of text.match(/.{1,12}/gsu) ?? []) yield { kind: 'text-delta', delta };
      }
      yield { kind: 'finish' };
    },
    sendsProviderTools: sends,
    observeActivity(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
