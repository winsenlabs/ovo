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
    const html = readFileSync(join(out('run'), 'ci.html'), 'utf8');
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Routing eval: ci');
    expect(html).toContain('Confusion: rules (19/19 as expected)');
    expect(html).not.toContain('<script');
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

  it('exits 2 on a usage error', async () => {
    expect(await main(['bogus'])).toBe(2);
    expect(await main(['--nope'])).toBe(2);
    expect(await main(['--help'])).toBe(0);
    expect(stderr.join('')).toContain('pnpm eval:routing');
  });
});

describe('the HTML scorecard', () => {
  it('shows a failing gate and a failing case, with the caller text escaped away', async () => {
    const dir = broken('sales-keypad-1', { status: 'agent', member: 'sales-hi' });
    expect(
      await main(['--corpus', dir, '--out', out('html'), '--baseline', BASELINE, '--label', 'h']),
    ).toBe(1);
    const html = readFileSync(join(out('html'), 'h.html'), 'utf8');
    expect(html).toContain('Gate: FAIL');
    expect(html).toContain('member: expected &#34;sales-hi&#34;, got &#34;sales-en&#34;');
    expect(html).toMatch(/background:rgba\(var\(--heat\),0\.\d+\)/);
    expect(html).not.toContain('mujhe');
  });
});

describe('pnpm eval:routing --live llm', () => {
  const keys = () => {
    const file = out('keys.env');
    writeFileSync(file, 'OPENAI_API_KEY=sk-test-not-a-real-key\n');
    return file;
  };
  /** An inference that never classifies anything, and records how it was built. */
  const built: { key: string; model: string; closed: boolean }[] = [];
  const unsure = (key: string, model: string) => {
    const record = { key, model, closed: false };
    built.push(record);
    return {
      model,
      generate: async () => ({
        kind: 'tool' as const,
        toolId: 'ovo_route',
        input: { branch: null, confidence: 0 },
      }),
      close: async () => void (record.closed = true),
    };
  };

  it('runs the classifier for real, labels the scorecard live and closes the model', async () => {
    const code = await main(
      ['--live', 'llm', '--llm-model', 'fake-model', '--keys', keys(), '--out', out('live')],
      { inference: unsure },
    );
    expect(code).toBe(0);
    expect(built).toEqual([{ key: 'sk-test-not-a-real-key', model: 'fake-model', closed: true }]);
    const card = JSON.parse(
      readFileSync(join(out('live'), 'routing-worked-example-live.json'), 'utf8'),
    );
    expect(card.engineMode).toBe('live');
    expect(card.totals.failed).toBeGreaterThan(0);
    expect(card.perEngine.llm.attempts).toBeGreaterThan(0);
    expect(stderr.join('')).toContain('FAIL');
    expect(readFileSync(join(out('live'), 'routing-worked-example-live.md'), 'utf8')).toContain(
      'engines live',
    );
  });

  it.each([
    [
      'an engine the CLI cannot run live',
      ['--live', 'llm,external', '--llm-model', 'm'],
      'only llm can run live',
    ],
    ['no model', ['--live', 'llm'], '--live llm needs --llm-model'],
  ])('refuses %s', async (_name, args, message) => {
    await expect(
      main([...args, '--keys', keys(), '--out', out('refused')], { inference: unsure }),
    ).rejects.toThrow(message);
  });

  it('refuses a run with no key, and a live baseline', async () => {
    const empty = out('no-key.env');
    writeFileSync(empty, '\n');
    await expect(
      main(['--live', 'llm', '--llm-model', 'm', '--keys', empty, '--out', out('nokey')], {
        inference: unsure,
      }),
    ).rejects.toThrow('needs OPENAI_API_KEY');
    expect(
      await main(
        ['--live', 'llm', '--llm-model', 'm', '--keys', keys(), '--save-baseline', out('b.json')],
        { inference: unsure },
      ),
    ).toBe(2);
  });
});
