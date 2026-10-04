# @winsendotai/ovo-plugin-knowledge-inline

Retrieval over documents carried on the agent release. The first `knowledge` plugin, and the one
that needs no infrastructure: no store, no vendor, no network, no migration.

## What it is for

An agent grounded in a policy document, a price list, a set of eligibility rules — text an operator
owns, that changes with a release, and that is too large to paste into every prompt. It replaces the
`context` blob, which is pasted whole into every inference request and **fails publication** above
`contextBudget` rather than being searched.

## How the score is computed, and why it is that

`KnowledgePassage.score` must be comparable **across queries**, because one authored
`AgentKnowledgePolicy.minScore` is applied to every turn. BM25 cannot give that: its scores are
unbounded and query-dependent, so 4.2 means nothing on its own.

So the score here is **the IDF-weighted fraction of the query's distinct terms that the passage
covers**, with term-frequency saturation. The denominator is the query's own total weight, so 0.5
always means "half the informative words, by weight". IDF is computed over the corpus itself, which
is how a frequent word is discounted with no stopword list to maintain per language.

`scoreBasis` is `'lexical'`, and a threshold tuned here **does not transfer** to a vector backend.

## What it cannot do

- **Match across morphology or meaning.** "owe" does not find "outstanding", and an agglutinative
  language will match far less than English. This is a lexical ranker; it does not pretend otherwise.
- **Change without a release.** The corpus is part of the immutable release — which is why
  `revision` is a hash of it and two calls on one release can never read different text, and why
  `mutableCorpus` is `false`.
- **Hold a large corpus.** 20 sources × 50 documents × 20,000 characters is the ceiling. A release
  is snapshotted and shipped, so an unbounded corpus here becomes an unbounded release. A corpus that
  outgrows this wants a stored backend behind the same port, not a larger limit here.

## Citations

A passage carries the author's own `citation`, else the document `title`, numbered `(n of m)` when a
document produced more than one passage. A document with neither gets **no citation** — never a
plausible-looking invention. `knowledge@1` has a check for exactly that.

## Chunking

Paragraph boundaries first — a policy document's clauses are already separated, and cutting
mid-clause is how retrieval starts quoting half a rule. Short paragraphs are packed up to 2,000
characters. A single paragraph above the budget is split on sentence boundaries, and only then, as a
last resort, on the budget itself, by code point so a surrogate pair is never halved.

## Fixtures

It publishes an **empty** fixture script. A fixture call requires every selected provider slot to
publish one, and this plugin opens no socket, so "it touches nothing" is a published claim the
fixture gate can check rather than an absence it has to guess at.

## Bar

`knowledge@1`: 10 checks, each proven to reject by a broken fake in `tests/negatives.test.ts`. Plus
44 tests over ranking, chunking, revision stability and the corpus caps.
