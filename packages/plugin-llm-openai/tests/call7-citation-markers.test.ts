import { describe, expect, it } from 'vitest';
import type { InferenceStreamEvent } from '@winsendotai/ovo-contracts';
import { openAiInference } from '../src/inference.ts';
import { StreamingCitationStripper, stripCitations } from '../src/web-search.ts';
import { enabled, request, scriptedNet, sse } from './web-search-fixtures.ts';

/**
 * Wave 12 (Maya call 8cb76efc, F3): turn 16's searched answer ended with OpenAI's citation marker,
 * which the TTS read out ("cite turn zero search one…"). The marker is as the call's speech event
 * logged it (segment speech-27, 02:56:03.123 UTC); its format, private-use characters around
 * `cite` and source ids (U+E200 start, U+E202 delimiter, U+E201 stop, an optional line locator), is
 * OpenAI's: https://developers.openai.com/api/docs/guides/citation-formatting (retrieved
 * 2026-10-14). How the provider split it across `response.output_text.delta` events was not
 * logged: the deltas below are MODELLED, split inside the marker.
 */
const MARKER = 'citeturn0search1turn0search0turn0search5';
const ANSWER =
  'I can walk you through the background, the breakup, and the aftermath step by step; would you like to start with how Yugoslavia formed?';

const streamed = (deltas: string[]) => () =>
  new Response(
    sse({
      type: 'response.created',
      response: { id: 'resp-c7', created_at: 0, model: 'gpt-6-luna' },
    }) +
      sse({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'm' },
      }) +
      deltas
        .map((delta) =>
          sse({ type: 'response.output_text.delta', item_id: 'm', output_index: 0, delta }),
        )
        .join('') +
      sse({
        type: 'response.completed',
        response: { id: 'resp-c7', usage: { input_tokens: 9, output_tokens: 9, total_tokens: 18 } },
      }),
    { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-c7' } },
  );

async function spoken(deltas: string[]): Promise<string> {
  const { net } = scriptedNet(streamed(deltas));
  const events: InferenceStreamEvent[] = [];
  for await (const event of openAiInference(net, 'fixture-key', enabled).stream(request()))
    events.push(event);
  return events.flatMap((event) => (event.kind === 'text-delta' ? [event.delta] : [])).join('');
}

describe('call 8cb76efc F3: OpenAI citation markers never reach the caller', () => {
  it('turn 16: drops the marker streamed whole after the answer', async () => {
    expect(await spoken([ANSWER, ` ${MARKER}`])).toBe(ANSWER);
  });

  it('drops a marker split across deltas, and one in mid-sentence with a line locator', async () => {
    const split = [ANSWER.slice(0, 40), `${ANSWER.slice(40)} ci`, 'teturn0sea', 'rch1'];
    expect(await spoken(split)).toBe(ANSWER);
    expect(
      await spoken([
        'Croatia declared independence in 1991 citeturn0file1L8-',
        'L13 and the war ended in 1995.',
      ]),
    ).toBe('Croatia declared independence in 1991 and the war ended in 1995.');
  });

  it('holds the marker until it closes, and never mutes the text after it', () => {
    const stripper = new StreamingCitationStripper();
    expect(stripper.push('Formed? citeturn0')).toBe('Formed?');
    expect(stripper.push('search1 Next.')).toBe(' Next.');
    expect(stripper.finish()).toBe('');
  });

  it('strips the marker from a whole reply, and its words once the marks are lost', () => {
    expect(stripCitations(`${ANSWER} ${MARKER}`)).toBe(ANSWER);
    // As the call's transcript kept it: the private-use characters gone, the words left.
    expect(stripCitations(`${ANSWER} citeturn0search1turn0search0turn0search5`)).toBe(ANSWER);
    expect(stripCitations('Turn left at the turn 2 sign.')).toBe('Turn left at the turn 2 sign.');
  });
});
