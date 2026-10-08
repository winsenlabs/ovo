# OpenAI inference plugin

`@winsendotai/ovo-provider-openai-inference`: the `llm` slot over the OpenAI Responses API, through
the AI SDK (`@ai-sdk/openai`). Agents in `context` and `agent` mode stream their replies through it.
Voice request tuning (reasoning effort, verbosity, service tier, prompt cache key) is described in
`docs/env-reference.md` (`OVO_LLM_*`).

## Web search

The model can search the web on its own and answer from live results. It is off by default and is
turned on per LLM binding:

```json
{
  "model": "gpt-6-luna",
  "api": "responses",
  "webSearch": {
    "enabled": true,
    "searchContextSize": "low",
    "userLocation": { "country": "IN", "city": "Bengaluru", "timezone": "Asia/Kolkata" },
    "allowedDomains": ["imd.gov.in", "weather.com"]
  }
}
```

| Field               | Required | Default | Notes                                                                                 |
| ------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled`           | yes      |         | `false` (or no `webSearch`) sends no search tool.                                     |
| `searchContextSize` | no       | `low`   | `low` / `medium` / `high`. Larger is slower and costs more search content tokens.     |
| `userLocation`      | no       |         | Approximate: `country` (ISO 3166-1 alpha-2), `city`, `region`, `timezone` (IANA).     |
| `allowedDomains`    | no       |         | Search only these domains and their subdomains, without `https://`. 1 to 100 entries. |
| `announce`          | no       | on      | Lines said while a search runs (below), or `false` for none.                          |
| `skipUnclearInput`  | no       | `true`  | Send the tool only with caller words that ask for something (below).                  |

How it behaves:

- The plugin sends OpenAI's provider-executed `web_search` tool (`openai.tools.webSearch`) next to
  the agent's own tools. OpenAI runs the search inside the same request; it never becomes an OVO
  tool call, and OVO tools (native, HTTP, MCP) work as before. No OVO tool may be named
  `web_search` while search is on. The system prompt lists web search results as a factual source.
- Responses API only. The binding schema allows no other `api`, and the plugin refuses one with
  `OpenAI web search needs the Responses API`.
- **Spoken output.** Answers arrive with inline citations (`([site](url))`, `【3†source】`, `[1]`),
  markdown links and URLs. The plugin removes citations, keeps a link's text and reduces a bare URL
  to its host before the text reaches the reply segmenter, holding back a citation split across
  stream deltas until it can remove it whole. The default markdown text filter
  (`@winsendotai/ovo-text-filter-markdown`) also drops citation groups and markers, as a second
  line before TTS.
- **Latency.** A search runs before the first answer sentence. In the Maya calls of 2026-10-07
  (gpt-6-luna, `low` context) a searched turn's first token came 3.9–5.0 s after the caller
  stopped (p50 3.95 s), against 1.72 s for the same agent's turns that did not search. Keep
  `searchContextSize` at `low` for calls.
- **What the caller hears (N3).** The plugin reports each search as the provider starts it, before
  it runs (the AI SDK surfaces `response.output_item.added` for the `web_search_call` as a
  provider-executed `tool-input-start`), through `observeActivity` on the inference port. The
  native engine then says `announce.line` at once, in place of a generic filler not yet due, and
  `announce.stillLine` if the answer has still not started `announce.stillAfterMs` later. A turn
  that does not search never hears them. Defaults:

  ```json
  {
    "announce": {
      "line": "Let me look that up.",
      "stillLine": "Still checking, one moment.",
      "stillAfterMs": 2500
    }
  }
  ```

  The agent's generic LAT-6 filler (`voice.turnDetector.config.filler`) plays on any slow turn,
  searched or not, so give an agent with web search neutral lines that promise no lookup, and an
  `afterMs` of 1500 or more so fast turns never hear one:

  ```json
  { "filler": { "lines": ["One moment."], "afterMs": 1500 } }
  ```

  The search lines are not in the release's pre-rendered clip inventory yet; they are synthesised
  live (about 140 ms to first audio on ElevenLabs flash).

- **Only words that ask get the tool (Wave 8).** With `skipUnclearInput` (the default) the search
  tool, and the line naming search results as a source, go only to a caller turn that asks for
  something: a question word, a request verb ("tell me", "check", "batao"), a thing callers have
  looked up ("weather", "flights", "visa"), a question mark on two or more words, or an answer to a
  question the agent just asked ("Chennai." after "Which city?"). Sent without it:
  - a turn cut off mid-word ("tell me about-", "Credit. Okay, so..."), or with no words;
  - only a yes, no, backchannel, greeting, exclamation, ask to wait or thanks ("Yes.", "No, no.",
    "Hello?", "Oh, my God.", "Wait. Hold on.", "Thank you, Danny.", "हाँ।", "சரி"), unless it is a
    yes to the agent's offer to look something up ("Shall I check the options for two?" then
    "Yeah."): the caller asked for that search. "I can't confirm that" is not an offer.
  - a statement that asks nothing and answers no question ("I'm in a coffee shop.").

  In the Maya calls of 2026-10-07 "No, no." and "Yes." each searched for 3.8–3.9 s only to restate
  the previous answer; in call 6e1a4e3a (2026-10-08) "Oh, my God." searched for 2.0 s
  (`tests/search-guard-call3.test.ts` replays every turn of that call). The word lists are in
  `@winsendotai/ovo-contracts` (`agent-unclear.ts`), shared with the agent's unclear-input lines.

- **Shorter answers after a search (Wave 8).** With the tool, the model is also told to search at
  most once per reply and then answer in one or two short spoken sentences that start with the key
  fact (`SEARCH_INSTRUCTIONS`). In call 6e1a4e3a a searched turn's first token came 4.0–7.3 s
  after the caller stopped (median 4.7 s) for searches of 1.9–3.5 s, and the long answers that
  followed were cut by the caller 7 times in 23 replies. The effect on time to first token is not
  measured yet: it needs a live call (compare `searchMs` with `llmFirstTokenMs` in the turn
  summaries). `searchContextSize` stays `low` by default.
- **Measuring first-token latency.** `scripts/measure-first-token.mjs` asks the Responses API the
  same non-search question with and without the search tool, with low verbosity, without the
  prompt cache key, with `store: true` and without encrypted reasoning, and prints time to first
  text and the token counts. It needs `OVO_MEASURE_OPENAI_KEY`, a key meant for experiments.

### Metering and price cards

A request the caller cuts off (barge-in, a superseded turn) reports no usage, so it is metered as
an estimate: its text plus what the call's last fully reported request carried beyond its text
(the search tool's own instructions, scaffolding and tool schemas, about 4,400 tokens on a first
request), split into cached and uncached as that request was, and one `web_search_calls` for each
search it had started (for a non-streamed request, one when it ran for 1.5 s or more).

Each search the model runs is metered as `openai.inference.web_search_calls` (unit
`web_search_calls`, one per search action; `open_page` and `find_in_page` actions are not
counted). The meter applies only to a binding with `webSearch.enabled: true`
(`when: { field: 'webSearch.enabled', in: ['true'] }`), so only those agents must price it: add a
`costPolicy.priceCards["openai.inference.web_search_calls"]` entry before releasing, or admission
refuses the call (`cost-meter-unconfigured`) and compat reports `meter_uncovered`. The vendor
catalog card `openai-web-search-calls` (`2026-10-07-confirmed`) is OpenAI's list price of
$10.00 per 1K calls for every model; the search content tokens are billed at the model's input rate
and already arrive in the token meters.

## A faster model: the gpt-5.4-mini preset (optional)

For an agent whose turns are latency-bound rather than reasoning-bound (a trip companion, a
receptionist), `gpt-5.4-mini` starts answering sooner: from India it gave its first token in
0.68–0.78 s steadily, against 0.75–1.2 s for gpt-6-luna and 1.1–1.3 s for gpt-4.1-mini (Wave 8
latency evidence D; one bench, not a production measurement). Bind it like this:

```json
{
  "model": "gpt-5.4-mini",
  "api": "responses",
  "webSearch": { "enabled": true, "searchContextSize": "low" }
}
```

- The plugin sends `reasoningEffort: "none"` (the lowest the model accepts, and its default) and
  `textVerbosity: "low"` (documented for the gpt-5 family), no stored responses, and a prompt cache
  key per binding, unless the binding or the `OVO_LLM_*` variables say otherwise.
- Web search is supported on the Responses API.
- List price (retrieved 2026-10-08 from https://developers.openai.com/api/docs/models/gpt-5.4-mini):
  $0.75 per 1M input tokens, $0.075 cached, $4.50 output; 400,000-token context; knowledge cutoff
  2025-08-31. Import or author price cards for `openai.inference.*` before releasing, as for any
  model, and expect answers from a smaller model: try it on a test call before switching an agent.
