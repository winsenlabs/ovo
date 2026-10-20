'use client';
import { useMemo } from 'react';
import { DataTableV2, type ColumnV2 } from '../../../components/ui/data-table-v2';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { nodeSteps } from '../../../lib/derive/routing-simulate';
import type { RoutingSimulationResult, SimulatedEngine } from '../../../lib/types/routing-simulate';

interface Row {
  id: string;
  turn: number;
  node: string;
  engine: string;
  outcome: string;
  branch?: string;
  confidence?: number;
  ms?: number;
  mocked: boolean;
  reason?: string;
}

/** Every engine attempt of the run. A scripted engine with no answer offers "Answer as…". */
export function TraceTable({
  result,
  onAnswerAs,
}: {
  result: RoutingSimulationResult;
  onAnswerAs?: (node: string, engine: SimulatedEngine) => void;
}) {
  const rows = useMemo<Row[]>(
    () =>
      nodeSteps(result).map(({ turn, step }, i) => {
        const p = step.payload;
        return {
          id: `${turn}-${i}`,
          turn,
          node: String(p.node ?? ''),
          engine: String(p.engine ?? ''),
          outcome: String(p.outcome ?? ''),
          branch: typeof p.branch === 'string' ? p.branch : undefined,
          confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
          ms: typeof p.ms === 'number' ? p.ms : undefined,
          mocked: step.mocked,
          reason: typeof p.reason === 'string' ? p.reason : undefined,
        };
      }),
    [result],
  );
  const columns: ColumnV2<Row>[] = [
    { id: 'turn', header: 'Turn', align: 'end', cell: (r) => r.turn },
    { id: 'node', header: 'Question', cell: (r) => <span className="mono">{r.node}</span> },
    { id: 'engine', header: 'Engine', cell: (r) => r.engine },
    {
      id: 'outcome',
      header: 'Result',
      cell: (r) => (
        <StatusBadgeV2
          value={
            r.outcome === 'low_confidence'
              ? 'degraded'
              : r.outcome === 'matched'
                ? 'passed'
                : r.outcome
          }
          label={r.outcome.replaceAll('_', ' ')}
          size="sm"
        />
      ),
    },
    { id: 'branch', header: 'Branch', cell: (r) => r.branch ?? '—' },
    {
      id: 'confidence',
      header: 'Confidence',
      align: 'end',
      priority: 'low',
      cell: (r) => (r.confidence === undefined ? '—' : `${Math.round(r.confidence * 100)}%`),
    },
    {
      id: 'ms',
      header: 'Time',
      align: 'end',
      priority: 'low',
      cell: (r) => (r.ms === undefined ? '—' : `${r.ms} ms`),
    },
    {
      id: 'mode',
      header: 'Mode',
      priority: 'low',
      cell: (r) =>
        r.engine === 'rules' || r.engine === 'context' ? 'Real' : r.mocked ? 'Scripted' : 'Real',
    },
    {
      id: 'reason',
      header: 'Reason',
      cell: (r) =>
        r.reason === 'unscripted' ? (
          <span className="rt-unscripted">
            No scripted answer{' '}
            {onAnswerAs && (
              <button
                type="button"
                className="button small"
                onClick={() => onAnswerAs(r.node, r.engine as SimulatedEngine)}
              >
                Answer as…
              </button>
            )}
          </span>
        ) : (
          (r.reason?.replaceAll('_', ' ') ?? '—')
        ),
    },
  ];
  return (
    <DataTableV2
      label="Engine attempts"
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      density="compact"
      empty="The run asked no engine anything."
    />
  );
}
