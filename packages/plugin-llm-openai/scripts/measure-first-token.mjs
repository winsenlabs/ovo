#!/usr/bin/env node
// Measures what an OVO voice turn waits for before the LLM's first token (Maya diagnosis N3,
// 2026-10-07: non-search turns took 1.72 s p50 to first token at reasoning `none` with a 4.7k-token
// cached prompt, against 1.05 s for the CreditMantri agent on the same model without web search).
// It asks the Responses API the same non-search question under each variant, interleaved so
// provider load drifts evenly, and prints time-to-first-text p50/p90 and the token counts.
//
//   OVO_MEASURE_OPENAI_KEY=sk-... node packages/plugin-llm-openai/scripts/measure-first-token.mjs \
//     [--model gpt-6-luna] [--runs 10] [--variants with-search,no-search]
//
// It never reads a key from a file: pass one meant for experiments in OVO_MEASURE_OPENAI_KEY.
// Each run is a billed request (and a search variant may bill a web search), so keep runs low.
// Wire format: https://developers.openai.com/api/reference/resources/responses/streaming-events
// (retrieved 2026-10-07).
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    model: { type: 'string', default: 'gpt-6-luna' },
    runs: { type: 'string', default: '8' },
    variants: { type: 'string' },
    question: { type: 'string', default: 'Three days, I think. We land on a Friday.' },
  },
});
const key = process.env.OVO_MEASURE_OPENAI_KEY;
if (!key) {
  console.error('Set OVO_MEASURE_OPENAI_KEY to an OpenAI key meant for experiments.');
  process.exit(2);
}

// Roughly the Maya agent's visible prompt: persona, OVO's source rule and a short history.
const INSTRUCTIONS = [
  "You are Maya, a warm Europe trip companion on a phone call with a traveller from India. Keep every answer to one or two short spoken sentences, never lists, and end with one short question when it helps the caller decide. Prefer what the caller already told you; ask before assuming dates, budgets or cities. Say numbers as words a listener can follow. If the caller's words are unclear, ask them to repeat instead of guessing. Never mention that you are an AI model or name a provider.".repeat(
    3,
  ),
  'Use only the supplied context, completed operation results and the results of your web search tool as factual sources.',
  'When the answer is not supported, respond exactly with: I am not sure about that.',
  'Supplied context:\nThe caller is planning a December trip to Zagreb and maybe Italy.',
].join('\n\n');
const HISTORY = [
  { role: 'assistant', content: "Hi! I'm Maya, your Europe trip companion. Where to?" },
  { role: 'user', content: 'We are planning to go to Zagreb this time.' },
  { role: 'assistant', content: 'Zagreb is lovely in December. How many days will you spend?' },
];
const END_CALL = {
  type: 'function',
  name: 'end_call',
  description: 'End the call after saying goodbye.',
  parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] },
  strict: false,
};
const SEARCH = { type: 'web_search', search_context_size: 'low' };

/** Each variant changes one thing from `with-search`, the binding the Maya calls ran. */
const VARIANTS = {
  'with-search': {},
  'no-search': { tools: [END_CALL] },
  'verbosity-low': { text: { verbosity: 'low' } },
  'no-cache-key': { prompt_cache_key: undefined },
  'store-true': { store: true, include: undefined },
  'no-encrypted-reasoning': { include: undefined },
};

function body(name, variant) {
  return JSON.stringify({
    model: values.model,
    instructions: INSTRUCTIONS,
    input: [...HISTORY, { role: 'user', content: values.question }],
    tools: [END_CALL, SEARCH],
    reasoning: { effort: 'none' },
    store: false,
    // What the AI SDK adds for store:false on a reasoning model (and sources for web search).
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: `ovo-measure-${name}`,
    stream: true,
    ...variant,
  });
}

async function once(name) {
  const startedAt = performance.now();
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: body(name, VARIANTS[name]),
  });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status} ${await response.text()}`);
  const result = { name, headersMs: performance.now() - startedAt, searched: false };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data: '));
      if (!data) continue;
      const event = JSON.parse(data.slice(6));
      const at = performance.now() - startedAt;
      if (event.type === 'response.created') result.createdMs ??= at;
      if (event.type === 'response.output_item.added' && event.item?.type === 'web_search_call')
        result.searched = true;
      if (event.type === 'response.output_text.delta') result.firstTextMs ??= at;
      if (event.type === 'response.completed') {
        result.totalMs = at;
        result.input = event.response.usage?.input_tokens;
        result.cached = event.response.usage?.input_tokens_details?.cached_tokens;
      }
    }
  }
  return result;
}

const quantile = (values, q) => {
  const sorted = values.filter((value) => value !== undefined).sort((a, b) => a - b);
  return sorted.length
    ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))])
    : null;
};

const names = values.variants ? values.variants.split(',') : Object.keys(VARIANTS);
for (const name of names) if (!VARIANTS[name]) throw new Error(`unknown variant ${name}`);
const runs = Number(values.runs);
const results = Object.fromEntries(names.map((name) => [name, []]));
// One warm-up each: it opens the connection and writes the prompt cache.
for (const name of names) await once(name);
for (let run = 0; run < runs; run++) for (const name of names) results[name].push(await once(name));

console.log('variant                 first-text p50/p90   created p50   input  cached  searched');
for (const name of names) {
  const rows = results[name];
  const pick = (field) => rows.map((row) => row[field]);
  console.log(
    [
      name.padEnd(22),
      `${quantile(pick('firstTextMs'), 0.5)}/${quantile(pick('firstTextMs'), 0.9)} ms`.padEnd(20),
      `${quantile(pick('createdMs'), 0.5)} ms`.padEnd(13),
      String(quantile(pick('input'), 0.5)).padEnd(6),
      String(quantile(pick('cached'), 0.5)).padEnd(7),
      `${rows.filter((row) => row.searched).length}/${rows.length}`,
    ].join(' '),
  );
}
