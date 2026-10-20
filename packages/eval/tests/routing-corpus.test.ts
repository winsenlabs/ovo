import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RoutingReleaseSnapshot } from '@winsendotai/ovo-contracts';
import { routingScorecardGate, scoreRoutingCorpus } from '@winsendotai/ovo-plugin-router';
import { describe, expect, it } from 'vitest';
import { loadCorpus, parseCases, scoreSetup } from '../src/routing/corpus.ts';
import { workedExampleSnapshot } from '../src/routing/worked-example.ts';

const CORPUS = fileURLToPath(new URL('../corpus/routing/worked-example', import.meta.url));
const BASELINE = fileURLToPath(
  new URL('../baselines/routing-worked-example.json', import.meta.url),
);
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;

describe('the worked-example routing corpus', () => {
  it('has the cases the docs and the router fixtures call for, one per id, tagged', async () => {
    const { cases } = await loadCorpus(CORPUS);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const tags = new Set(cases.flatMap((c) => c.tags));
    for (const tag of [
      'sales',
      'support',
      'fallback',
      'clarify',
      'human',
      'callback',
      'end',
      'idle',
      'dtmf-late',
      'reuse-turn',
    ])
      expect(tags, `tag ${tag}`).toContain(tag);
    // Every fallback step the scorer knows is reached by some case.
    expect(cases.map((c) => c.expect.fallback)).toEqual(
      expect.arrayContaining(['none', 'default', 'human', 'end', 'limit', 'release_default']),
    );
  });

  it('runs on a snapshot that is regenerated from exampleRoutingSnapshot, so it cannot drift', () => {
    const committed = RoutingReleaseSnapshot.parse(read(`${CORPUS}/snapshot.json`));
    expect(committed).toEqual(workedExampleSnapshot());
    expect(committed.schemaVersion).toBe(3);
    expect(Object.values(committed.queues).map((queue) => queue.key)).toEqual(['desk']);
    expect(committed.transfer?.targets.map((target) => target.key)).toEqual(['colleague']);
  });

  it('passes every case offline, and matches the committed baseline field for field', async () => {
    const corpus = await loadCorpus(CORPUS);
    const card = await scoreRoutingCorpus({
      snapshot: corpus.snapshot,
      cases: corpus.cases,
      name: corpus.manifest.name,
      engineMode: 'recorded',
      ...scoreSetup(corpus),
    });
    expect(card.failures).toEqual([]);
    expect(card.totals.failed).toBe(0);
    const baseline = read(BASELINE);
    expect(routingScorecardGate(baseline as never, card)).toEqual({ ok: true, failures: [] });
    // The gate would let an improvement through; the committed baseline must still be today's numbers.
    const { ms: _ms, ...fresh } = card;
    const { ms: _baselineMs, label: _label, ...committed } = baseline;
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(committed);
  });

  it('assumes transfers on, except for cases tagged no-transfer', async () => {
    const corpus = await loadCorpus(CORPUS);
    const normal = corpus.cases.find((c) => !c.tags.includes('no-transfer'))!;
    const off = corpus.cases.find((c) => c.tags.includes('no-transfer'))!;
    const flagsFor = (assume?: { transfer?: boolean; human?: boolean }) => {
      const { flags } = scoreSetup(corpus, assume);
      if (typeof flags !== 'function') throw new Error('flags are chosen per case');
      return flags;
    };
    expect(flagsFor()(normal)).toEqual({ transferEnabled: true, humanQueueEnabled: true });
    expect(flagsFor()(off)).toEqual({ transferEnabled: false, humanQueueEnabled: true });
    expect(flagsFor({ transfer: true })(off).transferEnabled).toBe(true);
  });
});

describe('parseCases', () => {
  const line = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: 'a',
      turns: [{ kind: 'dtmf', digits: '1' }],
      expect: { status: 'agent' },
      ...over,
    });

  it('reads one case per line and skips blank lines', () => {
    const cases = parseCases(`${line()}\n\n${line({ id: 'b' })}\n`);
    expect(cases.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cases[0]).toMatchObject({ tags: [], answers: [], call: { variables: {} } });
  });

  it.each([
    ['text that is not JSON', 'not json', 'cases:1: not valid JSON'],
    ['a case with an unknown field', line({ colour: 'red' }), 'cases:1:'],
    [
      'a case that expects nothing',
      line({ expect: {} }),
      'cases:1: expect A case expects something',
    ],
    ['a repeated id', `${line()}\n${line()}`, 'cases:2: case id a is used twice'],
  ])('names the line of %s', (_name, text, message) => {
    expect(() => parseCases(text)).toThrow(message);
  });

  it('refuses more than 500 cases', () => {
    const many = Array.from({ length: 501 }, (_, i) => line({ id: `c${i}` })).join('\n');
    expect(() => parseCases(many)).toThrow('501 cases; at most 500');
  });
});
