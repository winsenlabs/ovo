import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { RoutingReleaseSnapshot, RoutingKey } from '@winsendotai/ovo-contracts';
import {
  ROUTING_EVAL_LIMITS,
  ROUTING_EVAL_SCHEMA,
  RoutingEvalCase,
  type ScoreInput,
} from '@winsendotai/ovo-plugin-router';

const Assume = z
  .object({ transferEnabled: z.boolean().optional(), humanQueueEnabled: z.boolean().optional() })
  .strict();
const Disclosure = z.object({
  kind: z.enum(['identity', 'ai', 'recording', 'opt_out_hint']),
  text: z.string().min(1).max(500),
});

/** `corpus.json`: what the corpus is, which release it runs on, and what the run assumes. */
export const CorpusManifest = z
  .object({
    schema: z.literal(ROUTING_EVAL_SCHEMA),
    name: z.string().min(1).max(120),
    description: z.string().max(1_000).optional(),
    /** A `RoutingReleaseSnapshot` file, relative to this one. */
    snapshot: z.string().default('snapshot.json'),
    /** One JSON case per line, relative to this file. */
    cases: z.string().default('cases.jsonl'),
    /** The feature switches the run assumes. Absent: transfers off, human queues on. */
    assume: Assume.default({}),
    /** Cases with a tag run under that tag's assumptions instead (the first listed tag that matches). */
    overrides: z
      .array(z.object({ tag: RoutingKey, assume: Assume }).strict())
      .max(20)
      .default([]),
    /** What the router release's agent config contributes: its zone, and the disclosure it says. */
    router: z
      .object({
        timezone: z.string().optional(),
        disclosure: z.array(Disclosure).max(4).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CorpusManifest = z.infer<typeof CorpusManifest>;

export interface LoadedCorpus {
  dir: string;
  manifest: CorpusManifest;
  snapshot: RoutingReleaseSnapshot;
  cases: RoutingEvalCase[];
}

const readJson = async (file: string): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

/** Parses JSON-lines cases, naming the first line that does not parse or repeats an id. */
export function parseCases(text: string, source = 'cases'): RoutingEvalCase[] {
  const cases: RoutingEvalCase[] = [];
  const seen = new Set<string>();
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    const where = `${source}:${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not valid JSON`);
    }
    const parsed = RoutingEvalCase.safeParse(raw);
    if (!parsed.success)
      throw new Error(
        `${where}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(case)'} ${i.message}`).join('; ')}`,
      );
    if (seen.has(parsed.data.id))
      throw new Error(`${where}: case id ${parsed.data.id} is used twice`);
    seen.add(parsed.data.id);
    cases.push(parsed.data);
  });
  if (cases.length > ROUTING_EVAL_LIMITS.cases)
    throw new Error(`${source}: ${cases.length} cases; at most ${ROUTING_EVAL_LIMITS.cases}`);
  return cases;
}

export async function loadCorpus(dir: string): Promise<LoadedCorpus> {
  const root = resolve(dir);
  const manifest = CorpusManifest.parse(await readJson(join(root, 'corpus.json')));
  const snapshot = RoutingReleaseSnapshot.parse(await readJson(join(root, manifest.snapshot)));
  const cases = parseCases(await readFile(join(root, manifest.cases), 'utf8'), manifest.cases);
  return { dir: root, manifest, snapshot, cases };
}

/** The `ScoreInput` fields a corpus decides: the flags of each case, and the router. */
export function scoreSetup(
  corpus: LoadedCorpus,
  assume: { transfer?: boolean; human?: boolean } = {},
): Pick<ScoreInput, 'flags' | 'router'> {
  const { manifest } = corpus;
  const base = { transferEnabled: false, humanQueueEnabled: true, ...manifest.assume };
  const flagsFor = (testcase: RoutingEvalCase) => {
    const found = manifest.overrides.find((override) => testcase.tags.includes(override.tag));
    return { ...base, ...found?.assume };
  };
  return {
    flags: (testcase) => ({
      ...flagsFor(testcase),
      ...(assume.transfer ? { transferEnabled: true } : {}),
      ...(assume.human ? { humanQueueEnabled: true } : {}),
    }),
    router: manifest.router as ScoreInput['router'],
  };
}
