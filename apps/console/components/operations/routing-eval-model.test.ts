import { describe, expect, it } from 'vitest';
import { evalRun, evalSummary } from '../../tests/routing-eval-fixtures';
import {
  accuracyRows,
  describeRecord,
  engineRows,
  latestRun,
  matrixCells,
  oldestFirst,
  trendSeries,
} from './routing-eval-model';

const runs = [
  evalSummary({
    id: 'c',
    createdAt: '2026-10-19T09:00:00Z',
    headline: { passed: 9, total: 10, accuracy: 0.9, fallbackRate: 0.2, clarifyRate: 0 },
  }),
  evalSummary({
    id: 'a',
    createdAt: '2026-10-17T09:00:00Z',
    headline: { passed: 7, total: 10, accuracy: 0.7, fallbackRate: 0.4, clarifyRate: 0 },
  }),
  evalSummary({
    id: 'b',
    createdAt: '2026-10-18T09:00:00Z',
    headline: { passed: 0, total: 0, accuracy: null, fallbackRate: null, clarifyRate: null },
  }),
];

describe('routing eval trend', () => {
  it('orders runs oldest first and finds the latest', () => {
    expect(oldestFirst(runs).map((run) => run.id)).toEqual(['a', 'b', 'c']);
    expect(latestRun(runs)?.id).toBe('c');
    expect(latestRun([])).toBeUndefined();
  });

  it('draws accuracy and fallback rate across runs, skipping a run with no rate', () => {
    const [accuracy, fallback] = trendSeries(runs);
    expect(accuracy!.label).toBe('Accuracy');
    expect(accuracy!.points.map((p) => p.y)).toEqual([0.7, 0.9]);
    expect(fallback!.points.map((p) => p.y)).toEqual([0.4, 0.2]);
    expect(accuracy!.points[0]!.x).toBe(Date.parse('2026-10-17T09:00:00Z'));
  });

  it('draws nothing for no runs or runs with no rates', () => {
    expect(trendSeries([])).toEqual([]);
    expect(trendSeries([runs[2]!])).toEqual([]);
  });
});

describe('routing eval run tables', () => {
  const card = evalRun().scorecard;

  it('lists every field, with a field nothing asserted showing no rate', () => {
    const rows = accuracyRows(card);
    expect(rows.map((row) => row.field)).toEqual([
      'overall',
      'status',
      'path',
      'node',
      'branch',
      'pool',
      'member',
      'agent',
      'queue',
      'language',
    ]);
    expect(rows.find((row) => row.field === 'node')).toMatchObject({ total: 0, rate: null });
    expect(rows.find((row) => row.field === 'branch')).toMatchObject({ correct: 31, total: 33 });
  });

  it('skips a field the server left out', () => {
    const partial = { ...card, accuracy: { overall: card.accuracy.overall } } as typeof card;
    expect(accuracyRows(partial).map((row) => row.field)).toEqual(['overall']);
  });

  it('lists only the engines that were asked, in engine order', () => {
    expect(engineRows(card).map((row) => [row.engine, row.attempts])).toEqual([
      ['rules', 60],
      ['llm', 33],
    ]);
  });

  it('shades by the share of the expected row; the diagonal is the right answer', () => {
    const cells = matrixCells(card.confusion.llm!);
    expect(
      cells[0]!.map((cell) => [cell.value, cell.diagonal, Number(cell.share.toFixed(3))]),
    ).toEqual([
      [18, true, 0.947],
      [1, false, 0.053],
      [0, false, 0],
    ]);
    expect(matrixCells({ labels: ['a'], matrix: [[0]], correct: 0, total: 0 })[0]![0]!.share).toBe(
      0,
    );
  });

  it('describes expected and actual records for the failures table', () => {
    expect(describeRecord({ status: 'agent', path: ['a', 'b'], member: null })).toBe(
      'status=agent, path=["a","b"], member=null',
    );
    expect(describeRecord({})).toBe('nothing');
  });
});
