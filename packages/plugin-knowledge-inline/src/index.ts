import { Cap, type KnowledgeCapabilities } from '@winsendotai/ovo-contracts';
import { definePlugin } from '@winsendotai/ovo-runtime';
import { InlineKnowledge } from './search.ts';
import { readRowConfig, ROW_CONFIG_SCHEMA } from './config.ts';

export * from './chunk.ts';
export * from './rank.ts';
export * from './search.ts';
export * from './config.ts';

export const INLINE_KNOWLEDGE_PLUGIN_ID = '@winsendotai/ovo-knowledge-inline';
const MAX_PASSAGE_CHARACTERS = 2_000;

/**
 * `languages: ['*']`: the ranker is script-agnostic — `normalizeForMatch` keeps any Unicode letter,
 * and the IDF weights come from the corpus itself, so no per-language stopword list is maintained.
 * What it genuinely cannot do is match across morphology, which is a real limit for an agglutinative
 * language and is why `scoreBasis` says 'lexical' rather than claiming semantic search.
 */
export const INLINE_KNOWLEDGE_CAPABILITIES: KnowledgeCapabilities = Object.freeze({
  scoreBasis: 'lexical',
  maxTopK: 50,
  maxPassageCharacters: MAX_PASSAGE_CHARACTERS,
  languages: ['*'],
  citations: true,
  /** The corpus lives on the release, so it cannot change without one. */
  mutableCorpus: false,
});

export const inlineKnowledgePlugin = definePlugin(
  {
    id: INLINE_KNOWLEDGE_PLUGIN_ID,
    version: '0.1.0',
    contractVersion: 2,
    scope: 'session',
    kind: 'knowledge',
    provider: 'inline',
    provides: [Cap.knowledge],
    requires: [],
    configSchema: ROW_CONFIG_SCHEMA,
    secretFields: [],
    capabilities: INLINE_KNOWLEDGE_CAPABILITIES,
    // No meters: nothing is billed. Retrieval is in-process over text already on the release, so a
    // meter here would invent a unit nobody is charged for.
    runtime: { egressHosts: [], modelLicences: [] },
    conformance: ['knowledge@1'],
    ui: {
      slot: 'knowledge',
      label: 'Knowledge on the release',
      description:
        'Searches documents carried on the agent release. No store, no vendor, no network.',
    },
  },
  (ctx, row) => {
    ctx.provide(
      Cap.knowledge,
      new InlineKnowledge({
        sources: readRowConfig(row).sources,
        maxPassageCharacters: MAX_PASSAGE_CHARACTERS,
      }),
    );
  },
);

export const plugins = [inlineKnowledgePlugin];

/**
 * An EMPTY published script, deliberately. A fixture call requires every selected provider slot to
 * publish one, and this plugin opens no socket — `runtime.egressHosts` is empty — so "it touches
 * nothing" is published as a claim the fixture gate can check, rather than an absence it has to
 * guess at. An egress sentinel still asserts zero attempts.
 */
export const fixtures: Record<string, never[]> = { [INLINE_KNOWLEDGE_PLUGIN_ID]: [] };
