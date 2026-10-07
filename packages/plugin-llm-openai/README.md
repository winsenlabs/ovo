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
- **Latency.** A search runs before the first answer sentence, so a searched turn starts later
  (not yet measured on a live call). Keep `searchContextSize` at `low` for calls, and give the
  agent a LAT-6 filler line so the caller hears something while the model searches. It is set on
  `voice.turnDetector.config.filler`, needs the speech cache, and plays only when the reply has
  made no sound by `afterMs`:

  ```json
  { "filler": { "lines": ["One moment, let me check."], "afterMs": 600 } }
  ```

### Metering and price cards

Each search the model runs is metered as `openai.inference.web_search_calls` (unit
`web_search_calls`, one per search action; `open_page` and `find_in_page` actions are not
counted). The meter applies only to a binding with `webSearch.enabled: true`
(`when: { field: 'webSearch.enabled', in: ['true'] }`), so only those agents must price it: add a
`costPolicy.priceCards["openai.inference.web_search_calls"]` entry before releasing, or admission
refuses the call (`cost-meter-unconfigured`) and compat reports `meter_uncovered`. The vendor
catalog card `openai-web-search-calls` (`2026-10-07-confirmed`) is OpenAI's list price of
$10.00 per 1K calls for every model; the search content tokens are billed at the model's input rate
and already arrive in the token meters.
