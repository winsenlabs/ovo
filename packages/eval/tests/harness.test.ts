import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/commands.ts';
import { diffScorecards } from '../src/report/diff.ts';
import { runEval } from '../src/run.ts';
import type { Scorecard } from '../src/score/scorecard.ts';

/**
 * End to end on a tiny synthetic corpus (tests/fixtures/tiny: one made-up call, two caller turns,
 * a gold file and a VAD trace): a transcript replay through the production engine and detector,
 * scored against gold, then the reports and the gate.
 */
const corpus = fileURLToPath(new URL('./fixtures/tiny', import.meta.url));
const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

async function replayed(label: string, detectorConfig?: Record<string, unknown>) {
  const { card } = await runEval({
    corpus,
    mode: 'transcript',
    label,
    ...(detectorConfig ? { detectorConfig } : {}),
  });
  return card;
}

describe('the call-eval harness on a two-turn call', () => {
  it('replays both turns as the live call heard them, answered, and scores them against gold', async () => {
    const card = await replayed('baseline');
    const [call] = card.calls;
    expect(call!.gold).toBe(true);
    expect(call!.turns.map((turn) => [turn.text, turn.outcome, turn.rule])).toEqual([
      ['I want to go to Paris.', 'stopped', 'complete'],
      ['In December.', 'stopped', 'complete'],
    ]);
    // The live final answered each commit: the replay ends both turns where the call did.
    expect(call!.turns.map((turn) => turn.endMs)).toEqual([8100, 15500]);
    // The behaviour paces the recorded reply into its phrases, as it does live.
    expect(call!.turns.map((turn) => turn.reply)).toEqual([
      'Paris is lovely in December.',
      'December is festive,',
    ]);
    expect(call!.metrics).toMatchObject({
      answeredTurns: 2,
      goldThoughts: 2,
      splitRate: 0,
      mergeRate: 0,
      falseEndpoints: 0,
      missedReplies: 0,
      discardedReplies: 0,
      talkOver: 0,
      wer: 0,
      cer: 0,
      languageMismatches: 0,
      endpointP50Ms: 500,
    });
    // Two requests answered by the recorded replies, none unmatched.
    expect(call!.metrics.llmRequests).toBeGreaterThanOrEqual(2);
    expect(call!.notes.join(' ')).not.toContain('matched no live reply');
  });

  it('is deterministic: the same replay twice gives the same scorecard', async () => {
    const [a, b] = [await replayed('a'), await replayed('b')];
    expect(b.calls.map((call) => call.metrics)).toEqual(a.calls.map((call) => call.metrics));
    expect(diffScorecards(a, b).regressions).toEqual([]);
  });

  it('fails the gate when a candidate detector ends turns later than the baseline', async () => {
    const baseline = await replayed('baseline');
    // A 1.5 s commit silence: every turn waits that long before Scribe is asked to finalise.
    const candidate = await replayed('slow', {
      commit: { silenceMs: 1500, completeSilenceMs: 1500, commitAtStop: false },
    });
    const diff = diffScorecards(baseline, candidate);
    expect(candidate.aggregate.endpointP50Ms!).toBeGreaterThan(
      baseline.aggregate.endpointP50Ms! + 100,
    );
    expect(diff.regressions.some((r) => r.startsWith('aggregate endpointP50Ms'))).toBe(true);
  });

  it('writes JSON, Markdown and HTML, and the CLI exits 1 on a gate failure', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ovo-eval-'));
    dirs.push(out);
    expect(await main(['--corpus', corpus, '--label', 'base', '--out', out])).toBe(0);
    const card = JSON.parse(await readFile(join(out, 'base.json'), 'utf8')) as Scorecard;
    expect(card.calls[0]!.metrics.answeredTurns).toBe(2);
    expect(await readFile(join(out, 'base.md'), 'utf8')).toContain('| turn-1 |');
    const html = await readFile(join(out, 'base.html'), 'utf8');
    expect(html).toContain('<svg class="timeline"');
    expect(html).not.toMatch(/<script|https?:\/\//);
    const baseline = join(out, 'base.json');
    expect(
      await main(['--corpus', corpus, '--label', 'same', '--out', out, '--baseline', baseline]),
    ).toBe(0);
    const slow = JSON.stringify({
      commit: { silenceMs: 1500, completeSilenceMs: 1500, commitAtStop: false },
    });
    expect(
      await main([
        '--corpus',
        corpus,
        '--label',
        'slow',
        '--out',
        out,
        '--baseline',
        baseline,
        '--detector-config',
        slow,
      ]),
    ).toBe(1);
    expect(await readFile(join(out, 'slow.md'), 'utf8')).toContain('**Gate: FAIL**');
  });

  it('fails the gate for a detector that never ends a turn, though every count it leaves falls', async () => {
    const out = await mkdtemp(join(tmpdir(), 'ovo-eval-deaf-'));
    dirs.push(out);
    expect(await main(['--corpus', corpus, '--label', 'base', '--out', out])).toBe(0);
    const deaf = join(out, 'deaf.mjs');
    await writeFile(
      deaf,
      'export const createTurnDetector = { create: () => ({ observe() {}, on() { return () => {}; }, dispose() {} }) };\n',
    );
    const run = ['--corpus', corpus, '--label', 'deaf', '--out', out];
    const gate = ['--baseline', join(out, 'base.json'), '--detector', `module:${deaf}`];
    expect(await main([...run, ...gate])).toBe(1);
    const card = JSON.parse(await readFile(join(out, 'deaf.json'), 'utf8')) as Scorecard;
    expect(card.aggregate).toMatchObject({ answeredTurns: 0, uncoveredSegmentRate: 1 });
  });

  it('scores the call as it happened (live mode) without replaying it', async () => {
    const { card } = await runEval({ corpus, mode: 'live', label: 'live' });
    expect(card.calls[0]!.metrics).toMatchObject({
      answeredTurns: 2,
      llmRequests: 2,
      endpointP50Ms: 510,
    });
  });
});
