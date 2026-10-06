import { describe, expect, it } from 'vitest';
import type { InferenceRequest, NetPort, UsageMeter } from '@winsendotai/ovo-contracts';
import { estimateInputTokens } from '../src/aborted-usage.ts';
import { openAiInference } from '../src/inference.ts';

/** A provider that answers only when told to, and never once the request is aborted. */
function heldNet(answer?: () => Response) {
  let sent = 0;
  const net: NetPort = {
    fetch: (_url, init) => {
      sent += 1;
      return new Promise((resolve, reject) => {
        if (answer) resolve(answer());
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    },
    websocket() {
      throw new Error('not used');
    },
  };
  return { net, sent: () => sent };
}

const completed = () =>
  new Response(
    JSON.stringify({
      id: 'resp-1',
      created_at: 0,
      model: 'gpt-6-luna',
      output: [
        {
          type: 'message',
          role: 'assistant',
          id: 'msg-1',
          content: [{ type: 'output_text', text: 'Hello.', annotations: [] }],
        },
      ],
      usage: { input_tokens: 30, output_tokens: 2, total_tokens: 32 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function request(signal: AbortSignal): InferenceRequest {
  return {
    input: 'kya main kal pay kar sakta hoon?',
    history: [{ role: 'assistant', content: 'When would you be able to make this payment?' }],
    context: 'A collections agent on a call about a missed EMI.',
    uncertainty: 'I am not sure.',
    tools: [],
    results: [],
    signal,
  };
}

function setup(answer?: () => Response) {
  const meters: UsageMeter[] = [];
  const held = heldNet(answer);
  const inference = openAiInference(held.net, 'fixture-key', { model: 'gpt-6-luna' }, (meter) =>
    meters.push(meter),
  );
  return { inference, meters, sent: held.sent };
}

describe('an aborted LLM call is still metered (LAT-3)', () => {
  it('meters a stream aborted after it was sent as estimated input tokens', async () => {
    const { inference, meters, sent } = setup();
    const controller = new AbortController();
    const call = request(controller.signal);
    const next = inference.stream!(call)[Symbol.asyncIterator]().next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent()).toBe(1);
    controller.abort(new DOMException('the decision answered the turn', 'AbortError'));
    await expect(next).rejects.toThrow();
    const quantity = String(estimateInputTokens(call));
    expect(meters).toEqual([
      expect.objectContaining({
        provider: 'openai',
        operation: 'inference',
        unit: 'input_tokens',
        state: 'estimated',
        quantity,
        requestId: 'openai:aborted:1',
      }),
      expect.objectContaining({ unit: 'uncached_input_tokens', state: 'estimated', quantity }),
    ]);
    expect(Number(quantity)).toBeGreaterThan(20);
  });

  it('meters an aborted generate the same way, with its own request id', async () => {
    const { inference, meters } = setup();
    for (const _ of [1, 2]) {
      const controller = new AbortController();
      const reply = inference.generate(request(controller.signal));
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort();
      await expect(reply).rejects.toThrow();
    }
    expect(meters.map((meter) => meter.requestId)).toEqual([
      'openai:aborted:1',
      'openai:aborted:1',
      'openai:aborted:2',
      'openai:aborted:2',
    ]);
  });

  it('meters nothing extra for a call that finished or was never sent', async () => {
    const { inference, meters } = setup(completed);
    await inference.generate(request(new AbortController().signal));
    expect(meters.length).toBeGreaterThan(0);
    expect(meters.every((meter) => meter.state === 'reconciled')).toBe(true);
    const before = meters.length;
    const gone = new AbortController();
    gone.abort();
    await expect(inference.generate(request(gone.signal))).rejects.toThrow();
    expect(meters).toHaveLength(before);
  });
});
