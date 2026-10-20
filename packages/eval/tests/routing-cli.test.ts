import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/routing/commands.ts';

const CORPUS = fileURLToPath(new URL('../corpus/routing/worked-example', import.meta.url));
const BASELINE = fileURLToPath(
  new URL('../baselines/routing-worked-example.json', import.meta.url),
);
const scratch = mkdtempSync(join(tmpdir(), 'eval-routing-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let stderr: string[];
let stdout: string[];
beforeEach(() => {
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (chunk) => (stderr.push(String(chunk)), true),
  );
  vi.spyOn(process.stdout, 'write').mockImplementation(
    (chunk) => (stdout.push(String(chunk)), true),
  );
});
afterEach(() => vi.restoreAllMocks());

const out = (name: string) => join(scratch, name);
/** A copy of the worked-example corpus whose case `id` expects `expect` instead. */
function broken(id: string, expect: Record<string, unknown>): string {
  const dir = out(`corpus-${id}`);
  cpSync(CORPUS, dir, { recursive: true });
  const lines = readFileSync(join(dir, 'cases.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  lines.find((c) => c.id === id).expect = expect;
  writeFileSync(join(dir, 'cases.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return dir;
}

describe('pnpm eval:routing run', () => {
  it('scores the committed corpus, writes .json and .md, and passes its baseline gate', async () => {
    const code = await main(['--label', 'ci', '--out', out('run'), '--baseline', BASELINE]);
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('cases=45 passed=45');
    expect(stderr.join('')).toContain('gate passed');
    const card = JSON.parse(readFileSync(join(out('run'), 'ci.json'), 'utf8'));
    expect(card).toMatchObject({
      schema: 'ovo.routing-scorecard/1',
      label: 'ci',
      totals: { cases: 45, passed: 45 },
    });
    expect(card.generatedAt).toMatch(/^\d{4}-/);
    expect(readFileSync(join(out('run'), 'ci.md'), 'utf8')).toMatch(
      /^# Routing eval: ci\n[\s\S]*\*\*45 of 45 cases pass\.\*\*/,
    );
  });

  it('exits 1 and names the case when a case that passed in the baseline now fails', async () => {
    const dir = broken('sales-keypad-1', { status: 'agent', member: 'sales-hi' });
    const code = await main(['run', '--corpus', dir, '--out', out('bad'), '--baseline', BASELINE]);
    expect(code).toBe(1);
    const log = stderr.join('');
    expect(log).toContain('FAIL sales-keypad-1: member: expected "sales-hi", got "sales-en"');
    expect(log).toContain('GATE passed cases fell from 45 to 44');
    expect(log).toContain('GATE case sales-keypad-1 passed in the baseline and now fails');
    expect(log).toContain('GATE the corpus changed since the baseline was saved');
    expect(readFileSync(join(out('bad'), 'routing-worked-example.md'), 'utf8')).toContain(
      '## Gate: FAIL',
    );
  });

  it('runs without a baseline and exits 0 even with failing cases (only a gate fails a build)', async () => {
    const dir = broken('sales-keypad-1', { status: 'end' });
    expect(await main(['--corpus', dir, '--out', out('free')])).toBe(0);
    expect(stderr.join('')).toContain('FAIL sales-keypad-1');
  });

  it('does not let --thresholds hide a case that now fails', async () => {
    const dir = broken('sales-keypad-1', { status: 'agent', member: 'sales-hi' });
    const thresholds = out('thresholds.json');
    writeFileSync(
      thresholds,
      JSON.stringify({ passed: 1, accuracy: 0.5, allowCorpusChange: true }),
    );
    expect(
      await main([
        '--corpus',
        dir,
        '--out',
        out('lenient'),
        '--baseline',
        BASELINE,
        '--thresholds',
        thresholds,
      ]),
    ).toBe(1);
    expect(stderr.join('')).toContain(
      'GATE case sales-keypad-1 passed in the baseline and now fails',
    );
    expect(stderr.join('')).not.toContain('GATE passed cases fell');
  });

  it('saves a baseline without timings, which then gates the same corpus', async () => {
    const baseline = out('saved.json');
    expect(await main(['--out', out('save'), '--save-baseline', baseline])).toBe(0);
    expect(JSON.parse(readFileSync(baseline, 'utf8'))).toMatchObject({
      ms: { total: 0, p50: 0, p95: 0 },
    });
    expect(await main(['--out', out('save'), '--baseline', baseline])).toBe(0);
  });

  it('assumes the switches it is told to', async () => {
    expect(await main(['--out', out('assume'), '--assume-transfer', '--assume-human'])).toBe(0);
  });
});

describe('pnpm eval:routing diff', () => {
  it('passes a scorecard against itself and fails one against a stricter baseline', async () => {
    expect(await main(['diff', BASELINE, BASELINE])).toBe(0);
    expect(stdout.join('')).toContain('gate passed');
    const dir = broken('human-keypad-0', { status: 'end' });
    await main(['--corpus', dir, '--label', 'worse', '--out', out('diff')]);
    stdout = [];
    expect(
      await main(['diff', BASELINE, join(out('diff'), 'worse.json'), '--out', out('diff')]),
    ).toBe(1);
    expect(stdout.join('')).toContain('gate FAILED');
    expect(readFileSync(join(out('diff'), 'routing-diff.md'), 'utf8')).toContain('## Gate: FAIL');
  });

  it('applies --thresholds to the rates it compares', async () => {
    const worse = out('worse-rate.json');
    const card = JSON.parse(readFileSync(BASELINE, 'utf8'));
    card.fallbackRate = {
      ...card.fallbackRate,
      correct: card.fallbackRate.correct + 2,
      rate: card.fallbackRate.rate + 2 / 45,
    };
    writeFileSync(worse, JSON.stringify(card));
    const lenient = out('lenient.json');
    writeFileSync(lenient, JSON.stringify({ fallbackRate: 0.05 }));
    expect(await main(['diff', BASELINE, worse])).toBe(1);
    expect(stdout.join('')).toContain('fallback rate rose from 35.6% to 40.0%');
    expect(await main(['diff', BASELINE, worse, '--thresholds', lenient])).toBe(0);
  });

  it('reads only routing scorecards', async () => {
    const other = out('other.json');
    writeFileSync(other, JSON.stringify({ schema: 'something-else' }));
    await expect(main(['diff', BASELINE, other])).rejects.toThrow('not a routing scorecard');
  });

  it('needs two files', async () => {
    await expect(main(['diff', BASELINE])).rejects.toThrow('diff needs');
  });
});

describe('pnpm eval:routing snapshot and usage', () => {
  it('prints the worked-example snapshot, or writes it beside the corpus', async () => {
    expect(await main(['snapshot'])).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ schemaVersion: 3, name: 'Main line' });
    const dir = out('snap');
    cpSync(CORPUS, dir, { recursive: true });
    expect(await main(['snapshot', '--corpus', dir, '--write'])).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8')).schemaVersion).toBe(3);
  });

  it('exits 2 on a usage error and on --live, which needs credentials', async () => {
    expect(await main(['bogus'])).toBe(2);
    expect(await main(['--nope'])).toBe(2);
    expect(await main(['--live', 'llm'])).toBe(2);
    expect(await main(['--help'])).toBe(0);
    expect(stderr.join('')).toContain('pnpm eval:routing');
  });
});
