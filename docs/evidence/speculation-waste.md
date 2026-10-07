# Speculative decisions on partial transcripts: the waste, and what Wave 7 changed

Date: 2026-10-07. Code: `packages/behaviors/src/speculation{,-policy}.ts`. Regression test:
`packages/behaviors/tests/speculation-live-replay.test.ts`, which replays both live calls' caller
transcript streams (`tests/fixtures/speculation-live-calls.json`, words replaced by tokens).

## What the live calls did

`speculation.summary` of call B (8cbac365): 134 decisions started on partial transcripts, 129 Jev
calls, 25 reused, 83 discarded, 26 cancelled. Call A (4e4d2228): 48 calls, 11 reused.

Scribe's partials arrive every 0.9-1 s while the caller speaks and are rewritten each time, so
the 150 ms debounce let almost every one through. The final transcript is usually a different
rewrite: only 4 of 27 (call A) and 7 of 57 (call B) last partials equalled the final words, and
these were nearly all finished sentences ("Hello?", "Ananya, please stop.", "Okay, stop.", "Yes.").
Partials cut mid-phrase ("Can you please", "Yes, this is-", "Ma'am, what is the time") never
matched. The turn ends 1-2 ms after the final segment (manual commit), so the stable words decided
at that moment are the turn's own decision, not waste.

## The change

For revisable partials only (stable words are always decided):

- `partialEnding: 'sentence'` (default): once the call's STT has put punctuation in a partial,
  decide only partials that end a sentence (`.`, `?`, `!`, `।`, not a trailing `...`). An STT that
  never punctuates its partials (AssemblyAI's are unformatted) keeps the debounce alone, so its
  latency win is unchanged. `any` restores Wave 6 behaviour.
- `maxPartialCalls: 2` (default): at most two decision-model calls per utterance on partials, so
  a long monologue of finished sentences cannot run up calls.
- `skipped` in `speculation.summary` counts the partials left undecided.

Replayed through the real `DecisionSpeculation` with a 400 ms Jev:

| Call       | Policy | Jev calls | Reused | Wasted (discarded + cancelled) | Decision wait saved |
| ---------- | ------ | --------- | ------ | ------------------------------ | ------------------- |
| B 8cbac365 | Wave 6 | 137       | 45     | 92                             | 4,587 ms            |
| B 8cbac365 | Wave 7 | 89        | 57     | 32                             | 4,679 ms            |
| A 4e4d2228 | Wave 6 | 52        | 17     | 35                             | 574 ms              |
| A 4e4d2228 | Wave 7 | 39        | 26     | 13                             | 586 ms              |

Jev calls fall by 35% and 25%, waste by 65% and 63%, and no latency is lost: a turn waits for its
decision no longer than before (the turns that reused a verdict decided on a finished sentence
still do). The replay reproduces the live counts closely (137 calls against 129 live).

## Levers evaluated and not shipped

Simulated on the same streams before choosing:

- **A longer debounce** (300 or 500 ms instead of 150): call B 138 → 128/120 calls, call A's saved
  wait 575 → 433 ms. Partials come ~1 s apart, so any debounce short enough to keep the win lets the
  waste through.
- **A minimum number of new words** (2) before deciding a revision again: call B 138 → 134 calls,
  saved wait 4,587 → 4,187 ms. Small saving, real loss.
- **Not deciding while the agent's own speech is still playing** (the history the verdict depends
  on will change): call B 138 → 88 calls but saved wait 4,587 → 2,788 ms, because callers answer
  before the agent's line finishes. Losing the latency win was ruled out.
- **One decision in flight** was already the rule.
