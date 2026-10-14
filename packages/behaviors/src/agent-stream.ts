import {
  dropSpokenCitations,
  END_CALL_TOOL_ID,
  type AgentReplyPacing,
  type InferenceReply,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { AgentToolSelectionError } from './agent-tools.ts';
import { ReplyCap, type ReplyCapRecent } from './reply-cap.ts';
import { SpokenSentences } from './spoken-sentences.ts';
import { StreamingTextSegmenter } from './text-segmenter.ts';

export { ReplyProgress } from './reply-progress.ts';

/**
 * P7: square-bracketed text in a reply is a note, never speech ("[The response was interrupted.",
 * "[Playback evidence: estimated.]"): a model that copies one from its context must not have the
 * caller hear it. Stateful, because the segmenter splits a note across sentences. Wave 12 (call
 * 8cb76efc, F3): nor is a source citation a model or a provider leaves in ("…formed?" then a
 * private-use `cite` marker, read aloud as "cite turn zero search one"); a segment that is only
 * one is never said.
 */
export class InternalNotes {
  private open = false;

  /** The segment without its notes, or undefined when nothing speakable is left. */
  strip(segment: string): string | undefined {
    let kept = '';
    for (const char of dropSpokenCitations(segment)) {
      if (char === '[') this.open = true;
      else if (char === ']' && this.open) this.open = false;
      else if (!this.open) kept += char;
    }
    const text = kept.replace(/\s+/g, ' ').trim();
    return /[\p{L}\p{N}]/u.test(text) ? text : undefined;
  }
}

/** `InternalNotes` for a whole reply. */
export function stripInternalNotes(text: string): string | undefined {
  return new InternalNotes().strip(text);
}

export async function* streamAgentReply(
  events: AsyncIterable<InferenceStreamEvent>,
  language: string,
  assertCurrent: () => void,
  publish: (text: string) => string,
  /**
   * The model said its goodbye as text and then asked to end the call. Accepting it (true) keeps
   * the streamed goodbye; any other tool after text is still a protocol error. `'refused'`: a valid
   * `end_call` the call does not obey; `last` is the reply's last line, said or held by the cap.
   */
  endAfterText?: (input: unknown, last?: string) => boolean | 'refused',
  /**
   * The reply guardrail, run on each sentence as the segmenter produces it and before TTS sees it:
   * the text to speak, or undefined to drop the sentence. Never waits for the whole reply.
   */
  guard?: (segment: string) => string | undefined,
  /**
   * The agent's `reply` pacing (LAT-9, the first phrase and the long-answer cap), or its
   * `minFirstWords` alone; the defaults when absent.
   */
  pacing?: AgentReplyPacing | number,
  /**
   * The language the agent replies in (`config.language`, which can differ from the locale the
   * segmenter reads): call-3 #7's cap on long answers runs only when it is given.
   */
  replyLanguage?: string,
  /** Wave 9 (D5): what the agent said before, which decides whether the cap offers more. */
  recent?: ReplyCapRecent,
): AsyncGenerator<string, InferenceReply | undefined> {
  const reply: AgentReplyPacing =
    typeof pacing === 'number' ? { minFirstWords: pacing } : (pacing ?? {});
  const { minFirstWords, firstPhraseWords } = reply;
  const segmenter = new StreamingTextSegmenter(undefined, undefined, {
    language: language,
    ...(minFirstWords !== undefined ? { minFirstWords } : {}),
    ...(firstPhraseWords !== undefined ? { firstPhraseWords } : {}),
  });
  // Wave 12 (F5): an English reply's semicolons end its sentences, for the segmenter, the cap and
  // the TTS.
  const clauses = /^en\b/iu.test(replyLanguage ?? language) ? new SpokenSentences() : undefined;
  let toolReply: { kind: 'tool'; toolId: string; input: unknown } | undefined;
  let emittedText = false;
  let receivedText = false;
  const notes = new InternalNotes();
  const speakable = (segment: string) => {
    const text = notes.strip(segment);
    return text === undefined || !guard ? text : guard(text);
  };
  // Call-3 #7: a long answer stops after its first sentences and offers the rest. Once capped,
  // the rest is held, neither said nor checked, and the provider's stream is still read to its
  // end: a goodbye's `end_call` (or a flow's late `resume_flow`, taken upstream by
  // `interceptLateResume`) can follow the text, and the closing `finish` carries the usage the
  // request is metered by.
  let cap = replyLanguage === undefined ? undefined : new ReplyCap(reply, replyLanguage, recent);
  /** The checked sentence the cap stopped before, then the segments after it, unchecked. */
  let held: { stopped?: string; rest: string[] } | undefined;
  let offer: string | undefined;
  /** What to say now for a segment from the segmenter. */
  const take = (segment: string): string[] => {
    if (held) {
      held.rest.push(segment);
      return [];
    }
    const spoken = speakable(segment);
    if (spoken === undefined) return [];
    const { say, stop } = cap ? cap.next(spoken) : { say: spoken, stop: false };
    if (!stop) return say === undefined ? [] : [say];
    if (say === spoken) {
      held = { rest: [] };
      return [spoken];
    }
    held = { stopped: spoken, rest: [] };
    offer = say;
    return [];
  };
  /** The speakable lines the cap holds back, unchecked. */
  const heldLines = () =>
    [held?.stopped, ...(held?.rest ?? [])]
      .map((line) => (line === undefined ? undefined : stripInternalNotes(line)))
      .filter((line) => line !== undefined);
  /** A goodbye is said whole: what the cap held back, and anything after it uncapped. */
  const release = (): string[] => {
    const lines = held?.stopped === undefined ? [] : [held.stopped];
    for (const segment of held?.rest ?? []) {
      const spoken = speakable(segment);
      if (spoken !== undefined) lines.push(spoken);
    }
    [cap, held, offer] = [undefined, undefined, undefined];
    return lines;
  };
  for await (const event of events) {
    assertCurrent();
    if (event.kind === 'tool') {
      if (receivedText && event.toolId === END_CALL_TOOL_ID) {
        // Wave 12 (Maya call 8cb76efc turn 16): what the cap held is said only for a goodbye that
        // ends the call. Live, an end_call after a capped answer, refused because the answer ended
        // on a question, released all of it: 30 s of speech, its citation marker read out last.
        const ending = endAfterText?.(event.input, heldLines().at(-1));
        if (ending === 'refused') continue;
        for (const line of release()) {
          emittedText = true;
          yield publish(line);
        }
        if (ending) continue;
      }
      if (receivedText)
        throw new AgentToolSelectionError(
          event.toolId,
          'Tool call followed streamed response text',
        );
      if (toolReply) throw new AgentToolSelectionError(event.toolId, 'Multiple tool calls');
      toolReply = event;
    } else if (event.kind === 'text-delta') {
      if (toolReply)
        throw new AgentToolSelectionError(
          toolReply.toolId,
          'Streamed response text followed a tool call',
        );
      receivedText ||= Boolean(event.delta);
      for (const segment of segmenter.push(clauses ? clauses.push(event.delta) : event.delta))
        for (const line of take(segment)) {
          emittedText = true;
          yield publish(line);
        }
    }
  }
  for (const segment of [...segmenter.push(clauses?.finish() ?? ''), ...segmenter.finish()])
    for (const line of take(segment)) {
      emittedText = true;
      yield publish(line);
    }
  // Wave 12 (F7): a short tail the cap held is said in place of the offer, each line checked as
  // said. A question at its end is said only this way, with everything held before it.
  const stopped = held?.stopped === undefined ? undefined : held;
  if (stopped && cap?.shortTail(heldLines())) {
    for (const line of [
      stopped.stopped!,
      ...stopped.rest.flatMap((rest) => speakable(rest) ?? []),
    ]) {
      emittedText = true;
      yield publish(line);
    }
    offer = undefined;
  }
  // The offer is checked like any other line: the language guard may drop or replace it.
  const more = offer === undefined || !guard ? offer : guard(offer);
  if (more !== undefined) {
    emittedText = true;
    yield publish(more);
  }
  if (emittedText) return;
  return toolReply ?? { kind: 'text' as const, text: '' };
}
