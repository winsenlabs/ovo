import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  parseKeysFile,
  readKeys,
  STT_CONFIGS,
  sttConfig,
  sttStatus,
} from '../src/audio/stt-configs.ts';
import { diffScorecards } from '../src/report/diff.ts';
import { markdownReport } from '../src/report/markdown.ts';
import { runEval } from '../src/run.ts';
import { emptyRaw, metricsOf, percentile, sumRaw, type RawScore } from '../src/score/metrics.ts';
import { scorecard, type CallScore, type Scorecard } from '../src/score/scorecard.ts';

function call(name: string, raw: Partial<RawScore>): CallScore {
  const full = { ...emptyRaw(), ...raw };
  return {
    call: name,
    mode: 'transcript',
    gold: full.goldThoughts !== null,
    speechSource: 'gold',
    notes: [],
    metrics: metricsOf(full),
    raw: full,
    canned: {},
    turns: [],
    utterances: [],
    lines: [],
  };
}
const card = (label: string, calls: CallScore[]): Scorecard =>
  scorecard(label, 'transcript', { detector: 'rules' }, calls, '2026-10-15T00:00:00.000Z');

describe('metrics', () => {
  it('pools samples and sums counts across calls; gold rates use only calls with gold', () => {
    const a: Partial<RawScore> = {
      answeredTurns: 10,
      goldThoughts: 8,
      goldTurns: 10,
      splitThoughts: 2,
      llmRequests: 12,
      goldLlmRequests: 12,
      sttEdits: 5,
      sttWords: 50,
      samples: { endpointMs: [500, 700], firstAudioMs: [], firstAnswerMs: [], replyLatencyMs: [] },
    };
    const b: Partial<RawScore> = {
      answeredTurns: 10,
      llmRequests: 30,
      samples: { endpointMs: [], firstAudioMs: [], firstAnswerMs: [], replyLatencyMs: [] },
    };
    const total = metricsOf(
      sumRaw([
        { ...emptyRaw(), ...a },
        { ...emptyRaw(), ...b },
      ]),
    );
    expect(total).toMatchObject({
      answeredTurns: 20,
      splitRate: 0.25,
      llmPerTurn: 2.1,
      // Only the call with gold: 12 requests over 8 thoughts.
      llmPerThought: 1.5,
      wer: 0.1,
      endpointP50Ms: 500,
      endpointP90Ms: 700,
    });
    expect(metricsOf(emptyRaw())).toMatchObject({
      splitRate: null,
      wer: null,
      endpointP50Ms: null,
    });
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
  });
});

describe('the regression gate', () => {
  const base = card('base', [
    call('call7', {
      answeredTurns: 20,
      goldThoughts: 15,
      goldTurns: 20,
      splitThoughts: 3,
      missedReplies: 1,
      cannedLines: 2,
    }),
    call('call8', { answeredTurns: 29, cannedLines: 1 }),
  ]);

  it('passes an identical or better candidate', () => {
    expect(diffScorecards(base, base).regressions).toEqual([]);
    const better = card('better', [
      call('call7', {
        answeredTurns: 16,
        goldThoughts: 15,
        goldTurns: 16,
        splitThoughts: 1,
        missedReplies: 1,
        cannedLines: 1,
      }),
      call('call8', { answeredTurns: 20, cannedLines: 0 }),
    ]);
    const diff = diffScorecards(base, better);
    expect(diff.regressions).toEqual([]);
    expect(diff.aggregate.find((row) => row.spec.key === 'splitRate')?.verdict).toBe('better');
  });

  it('fails past a threshold on the aggregate, and on any call for the zero-tolerance metrics', () => {
    const worse = card('worse', [
      call('call7', {
        answeredTurns: 22,
        goldThoughts: 15,
        goldTurns: 22,
        splitThoughts: 5,
        missedReplies: 2,
        cannedLines: 2,
      }),
      // One canned line fewer here hides the extra one in call 7 from the aggregate: not from the gate.
      call('call8', { answeredTurns: 29, cannedLines: 0 }),
    ]);
    const diff = diffScorecards(base, worse);
    expect(diff.regressions).toEqual([
      'aggregate splitRate: 0.2 → 0.3333333333333333 (limit +0.05)',
      'aggregate missedReplies: 1 → 2 (limit +0)',
      'call7 missedReplies: 1 → 2 (limit +0)',
    ]);
    expect(markdownReport(worse, diff)).toContain('**Gate: FAIL**');
  });

  it('fails when a baseline call is missing from the candidate run, and takes custom thresholds', () => {
    const fewer = card('fewer', [base.calls[0]!]);
    expect(diffScorecards(base, fewer).regressions).toEqual([
      'call8: in the baseline but not the candidate run',
    ]);
    const looser = diffScorecards(
      base,
      card('worse', [call('call7', { ...base.calls[0]!.raw, splitThoughts: 5 }), base.calls[1]!]),
      { splitRate: 0.5 },
    );
    expect(looser.regressions).toEqual([]);
  });
});

describe('STT configurations and keys', () => {
  it('reads a keys file without exporting it, and says which configs can run', () => {
    const keys = parseKeysFile(
      '# keys\nELEVENLABS_API_KEY=el-test\nexport ASSEMBLYAI_API_KEY="aai-test"\n\n',
    );
    expect(keys).toEqual({ ELEVENLABS_API_KEY: 'el-test', ASSEMBLYAI_API_KEY: 'aai-test' });
    expect(sttStatus(sttConfig('scribe-auto'), keys)).toBe('ready');
    expect(sttStatus(sttConfig('assemblyai-multi'), keys)).toBe('ready');
    expect(sttStatus(sttConfig('deepgram-nova3-multi'), keys)).toBe('pending key');
    expect(sttStatus(sttConfig('cartesia-ink2'), keys)).toBe('unavailable');
    expect(() => sttConfig('whisper')).toThrow(/unknown STT config/);
    expect(new Set(STT_CONFIGS.map((c) => c.provider))).toEqual(
      new Set(['elevenlabs', 'assemblyai', 'deepgram', 'sarvam', 'openai', 'cartesia']),
    );
  });
});

describe('live runs refuse without their keys', () => {
  const corpus = fileURLToPath(new URL('./fixtures/tiny', import.meta.url));

  it('reads a key from OVO_EVAL_<name> when there is no keys file', async () => {
    const env = { OVO_EVAL_OPENAI_API_KEY: 'sk-test', OPENAI_API_KEY: 'not this one' };
    expect(await readKeys(undefined, env)).toEqual({ OPENAI_API_KEY: 'sk-test' });
  });

  it('refuses an STT config whose key is missing, and a live LLM with no OpenAI key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-eval-keys-'));
    const keysFile = join(dir, 'keys.env');
    writeFileSync(keysFile, 'ELEVENLABS_API_KEY=el-test\n');
    try {
      const run = (options: { stt?: string; llmModel?: string }) =>
        runEval({ corpus, mode: 'audio', label: 'refused', keysFile, ...options });
      await expect(run({ stt: 'assemblyai-en' })).rejects.toThrow(/assemblyai-en is pending key/);
      await expect(run({ stt: 'cartesia-ink2' })).rejects.toThrow(/cartesia-ink2 is unavailable/);
      await expect(run({ stt: 'scribe-en', llmModel: 'gpt-test' })).rejects.toThrow(
        /a live LLM needs OPENAI_API_KEY/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the eval package kind', () => {
  const root = mkdtempSync(join(tmpdir(), 'ovo-eval-kind-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const pkg = (dir: string, name: string, source: string) => {
    mkdirSync(join(root, dir, 'src'), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, private: true }));
    writeFileSync(join(root, dir, 'src', 'index.ts'), source);
  };

  it('may import plugins but not apps, and only tests may import it', () => {
    pkg(
      'packages/eval',
      '@winsendotai/ovo-eval',
      "import '@winsendotai/ovo-plugin-x';\nimport '@winsendotai/ovo-app';\n",
    );
    pkg('packages/plugin-x', '@winsendotai/ovo-plugin-x', "import '@winsendotai/ovo-eval';\n");
    pkg('apps/app', '@winsendotai/ovo-app', '');
    writeFileSync(
      join(root, 'package-kinds.json'),
      JSON.stringify({
        kinds: { 'packages/eval': 'eval', 'packages/plugin-x': 'vendor-plugin', 'apps/app': 'app' },
      }),
    );
    mkdirSync(join(root, 'baselines'));
    const run = spawnSync(
      process.execPath,
      ['scripts/check-architecture.mjs', '--root', root, '--baseline-dir', join(root, 'baselines')],
      {
        encoding: 'utf8',
      },
    );
    const output = `${run.stdout}${run.stderr}`;
    expect(output).toContain('the eval harness may not import apps (packages/eval -> apps/app)');
    expect(output).toContain('(packages/plugin-x -> packages/eval)');
    expect(output).not.toContain('(packages/eval -> packages/plugin-x)');
  });
});
