import {
  END_CALL_TOOL_ID,
  type InferenceReply,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';
import { AgentToolSelectionError } from './agent-tools.ts';
import { StreamingTextSegmenter } from './text-segmenter.ts';

export async function* streamAgentReply(
  events: AsyncIterable<InferenceStreamEvent>,
  language: string,
  assertCurrent: () => void,
  publish: (text: string) => string,
  /**
   * The model said its goodbye as text and then asked to end the call. Accepting it (true) keeps
   * the streamed goodbye; any other tool after text is still a protocol error.
   */
  endAfterText?: (input: unknown) => boolean,
  /**
   * The reply guardrail, run on each sentence as the segmenter produces it and before TTS sees it:
   * the text to speak, or undefined to drop the sentence. Never waits for the whole reply.
   */
  guard?: (segment: string) => string | undefined,
  /** LAT-9 per agent (`reply.minFirstWords`); the segmenter's default when absent. */
  minFirstWords?: number,
): AsyncGenerator<string, InferenceReply | undefined> {
  const segmenter = new StreamingTextSegmenter(undefined, undefined, {
    language: language,
    ...(minFirstWords !== undefined ? { minFirstWords } : {}),
  });
  let toolReply: { kind: 'tool'; toolId: string; input: unknown } | undefined;
  let emittedText = false;
  let receivedText = false;
  for await (const event of events) {
    assertCurrent();
    if (event.kind === 'tool') {
      if (receivedText && event.toolId === END_CALL_TOOL_ID && endAfterText?.(event.input))
        continue;
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
      for (const segment of segmenter.push(event.delta)) {
        const spoken = guard ? guard(segment) : segment;
        if (spoken === undefined) continue;
        emittedText = true;
        yield publish(spoken);
      }
    }
  }
  for (const segment of segmenter.finish()) {
    const spoken = guard ? guard(segment) : segment;
    if (spoken === undefined) continue;
    emittedText = true;
    yield publish(spoken);
  }
  if (emittedText) return;
  return toolReply ?? { kind: 'text' as const, text: '' };
}
