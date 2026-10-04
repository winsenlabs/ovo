# The knowledge slot

A `knowledge` plugin answers a question with **passages and their provenance**. It never answers the
caller, never summarises and never decides what to use — the behaviour decides, so a weak match stays
visibly weak instead of becoming confident prose.

Selected per agent and pinned per release, like `engine`, `carrier`, `stt`, `tts`, `llm` and
`decision`. The first plugin is `packages/plugin-knowledge-inline`.

## What it replaced

| Before                  | Why it was not enough                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faq[]` (≤1000 entries) | Matched by **token overlap** (`packages/behaviors/src/faq.ts`). Lexical and authored Q/A, not a document corpus: "how much do I owe" misses "what is my outstanding" unless the alias is written. |
| `context` (≤100k chars) | `assembleBoundedContext` **throws** above `contextBudget`. Not truncated, not chunked, not queried — the whole blob goes into every inference request. More knowledge _failed publication_.       |
| An HTTP or MCP tool     | Works, and still does. But the knowledge lives outside OVO: no chunking, no citations, no freshness, no cost accounting on retrieval, and the LLM decides when to call it.                        |

## What an operator authors

Two separate things, on purpose:

- **The corpus** belongs to the selected plugin's row config, on the plugins page. It is the
  plugin's business how it stores and ranks.
- **The policy** (`AgentConfig.knowledge`) belongs to the agent, in the studio: which sources it may
  read, how many passages, **how weak a match is still acceptable** (`minScore`, which has no
  default — a retrieval threshold nobody chose is a threshold nobody owns), how many characters of
  retrieved text one turn may spend, a deadline, and whether an ungrounded turn should refuse.

## What the runtime does

`Grounding` (`packages/behaviors/src/grounding.ts`) retrieves **once per turn**, before the decision,
and re-validates the result itself — ranked order is exactly what the budget trim depends on, and a
third-party knowledge plugin is the point of the boundary.

- Passages below `minScore` are discarded before anything sees them.
- Passages are then kept in rank order until `maxCharacters` is spent. A passage is **dropped whole,
  never truncated**: half a clause of policy read back to a caller is worse than one passage fewer.
  The budget is counted by code point, so an emoji costs one.
- The kept passages are appended to the briefing for the LLM, and offered to the decision as the
  `knowledge` state source. Same passages, both places.
- Timeout, transport failure or an incoherent result → the turn continues **ungrounded**, recorded on
  `behavior.groundings` with the corpus revision. A retrieval backend being slow or down must not
  drop a live call.
- Unless `requireGrounding` is set. Then a turn with no passage above the threshold speaks the
  uncertainty line and **never reaches the LLM**. For an agent whose answers are only safe when
  grounded — a policy, a price, an eligibility rule — that is the correct trade.

## What is refused before a release exists

| Code                       | When                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge_plugin_missing` | Grounding is enabled and no knowledge plugin is selected. **Error.**                                                                                                          |
| `knowledge_plugin_unused`  | A knowledge plugin is selected and grounding is off. Warning.                                                                                                                 |
| `knowledge_limit_exceeded` | `topK` above the manifest's `maxTopK`, or a language the plugin does not list. **Error.** A character budget below one passage, so a full passage would always drop. Warning. |

The language rule matters most. A lexical backend asked a question in a language it does not list
returns nothing, and **an ungrounded agent looks exactly like a grounded one that found nothing**.

## Scores are only comparable within one plugin

`KnowledgeCapabilities.scoreBasis` says whether a score came from lexical overlap, a vector distance,
a hybrid or a vendor's own relevance. One authored `minScore` is applied to every turn, so it has to
be comparable across queries — `knowledge@1` checks that directly, by scoring the same passage
against a focused and a diluted query. It does **not** transfer across backends: a threshold tuned
against the inline lexical plugin means something different against a vector one.

## What the kit cannot prove

That retrieval is **good**. Relevance is judged against real questions, not a kit corpus. A green
`knowledge@1` run means the port is honest about what it found — verbatim spans, ranked, cited, with
a traceable revision, and nothing for a term that is absent — not that it found the right thing.
