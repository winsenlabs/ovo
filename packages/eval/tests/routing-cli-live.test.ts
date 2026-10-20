import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/routing/commands.ts';

const scratch = mkdtempSync(join(tmpdir(), 'eval-routing-live-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (chunk) => (stderr.push(String(chunk)), true),
  );
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

const out = (name: string) => join(scratch, name);

describe('pnpm eval:routing --live', () => {
  const keys = (text = 'OPENAI_API_KEY=sk-test-not-a-real-key\n') => {
    const file = out('keys.env');
    writeFileSync(file, text);
    return file;
  };
  /** An inference that never classifies anything, and records how it was built. */
  const built: {
    provider: string;
    key: string;
    model: string;
    baseUrl?: string;
    closed: boolean;
  }[] = [];
  const unsure = ({
    provider,
    apiKey,
    model,
    baseUrl,
  }: {
    provider: string;
    apiKey: string;
    model: string;
    baseUrl?: string;
  }) => {
    const record = { provider, key: apiKey, model, ...(baseUrl ? { baseUrl } : {}), closed: false };
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
  beforeEach(() => void (built.length = 0));
  afterEach(() => vi.unstubAllEnvs());

  it('runs the classifier for real, labels the scorecard live and closes the model', async () => {
    const code = await main(
      ['--live', 'llm', '--llm-model', 'fake-model', '--keys', keys(), '--out', out('live')],
      { inference: unsure },
    );
    expect(code).toBe(0);
    expect(built).toEqual([
      { provider: 'openai', key: 'sk-test-not-a-real-key', model: 'fake-model', closed: true },
    ]);
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

  it('takes the key variable, base URL and model from flags or OVO_EVAL_LLM_* variables', async () => {
    await main(
      [
        '--live',
        'llm',
        '--llm-model',
        'm-flag',
        '--llm-key-env',
        'MY_GATEWAY_KEY',
        '--llm-base-url',
        'https://gateway.example.test/v1/',
        '--keys',
        keys('MY_GATEWAY_KEY=gw-key\nOPENAI_API_KEY=not-this-one\n'),
        '--out',
        out('flags'),
      ],
      { inference: unsure },
    );
    vi.stubEnv('OVO_EVAL_LLM_MODEL', 'm-env');
    vi.stubEnv('OVO_EVAL_LLM_PROVIDER', 'openai');
    vi.stubEnv('OVO_EVAL_LLM_BASE_URL', 'http://localhost:8080/v1');
    await main(['--live', 'llm', '--keys', keys(), '--out', out('env')], { inference: unsure });
    expect(
      built.map(({ provider, key, model, baseUrl }) => ({ provider, key, model, baseUrl })),
    ).toEqual([
      {
        provider: 'openai',
        key: 'gw-key',
        model: 'm-flag',
        baseUrl: 'https://gateway.example.test/v1',
      },
      {
        provider: 'openai',
        key: 'sk-test-not-a-real-key',
        model: 'm-env',
        baseUrl: 'http://localhost:8080/v1',
      },
    ]);
  });

  it('runs the decision engine live on its own key and calibration label', async () => {
    const made: unknown[] = [];
    const decide = async () => {
      throw new Error('no network in tests');
    };
    const code = await main(
      [
        '--live',
        'decision',
        '--decision-calibration-label',
        'cohort-1',
        '--decision-model',
        'jev-x',
        '--keys',
        keys('JEV_API_KEY=jev-test-key\n'),
        '--out',
        out('decision'),
      ],
      {
        decision: (config) => (made.push(config), { decide }) as never,
      },
    );
    expect(code).toBeLessThanOrEqual(1);
    expect(made).toEqual([
      { apiKey: 'jev-test-key', calibrationLabel: 'cohort-1', model: 'jev-x' },
    ]);
    expect(built).toEqual([]);
    const card = JSON.parse(
      readFileSync(join(out('decision'), 'routing-worked-example-live.json'), 'utf8'),
    );
    expect(card.engineMode).toBe('live');
  });

  it.each([
    [
      'an engine the CLI cannot run live',
      ['--live', 'llm,external', '--llm-model', 'm'],
      'only llm, decision can run live',
    ],
    ['no model', ['--live', 'llm'], '--live llm needs --llm-model'],
    [
      'an unknown provider',
      ['--live', 'llm', '--llm-model', 'm', '--llm-provider', 'nope'],
      'one of openai',
    ],
    [
      'a base URL that is not https',
      ['--live', 'llm', '--llm-model', 'm', '--llm-base-url', 'http://example.test/v1'],
      '--llm-base-url must be https',
    ],
    [
      'a base URL with a secret in it',
      ['--live', 'llm', '--llm-model', 'm', '--llm-base-url', 'https://u:p@example.test/v1'],
      'cannot carry credentials',
    ],
    [
      'a key variable that is not a name',
      ['--live', 'llm', '--llm-model', 'm', '--llm-key-env', 'a b'],
      'not a variable name',
    ],
    [
      'no calibration label',
      ['--live', 'decision'],
      '--live decision needs --decision-calibration-label',
    ],
  ])('refuses %s', async (_name, args, message) => {
    await expect(
      main(
        [...args, '--keys', keys('JEV_API_KEY=k\nOPENAI_API_KEY=k\n'), '--out', out('refused')],
        {
          inference: unsure,
        },
      ),
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
    await expect(
      main(
        [
          '--live',
          'decision',
          '--decision-calibration-label',
          'c',
          '--keys',
          empty,
          '--out',
          out('nokey2'),
        ],
        {},
      ),
    ).rejects.toThrow('needs JEV_API_KEY');
    expect(
      await main(
        ['--live', 'llm', '--llm-model', 'm', '--keys', keys(), '--save-baseline', out('b.json')],
        { inference: unsure },
      ),
    ).toBe(2);
  });
});
