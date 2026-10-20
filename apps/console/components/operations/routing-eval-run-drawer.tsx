'use client';
import { useEffect, useState } from 'react';
import { RunBody } from './routing-eval-run-body';
import {
  routingEvalApi,
  type RoutingEvalRun,
  type RoutingEvalRunSummary,
} from '../../lib/data/routing-eval-api';
import { WideDrawer } from '../inspector/route-wide-drawer';
import { ErrorState, Skeleton } from '../ui/feedback-v2';
import { formatDateTime } from '../../lib/format';

type RunState =
  | { status: 'loading' }
  | { status: 'ready'; run: RoutingEvalRun }
  | { status: 'error'; message: string };

/** One routing eval run in full, fetched when opened: it carries the whole scorecard. */
export function RoutingEvalRunDrawer({
  summary,
  onClose,
}: {
  summary: RoutingEvalRunSummary | null;
  onClose: () => void;
}) {
  const [state, setState] = useState<RunState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const id = summary?.id;
  useEffect(() => {
    if (!id) return;
    let current = true;
    setState({ status: 'loading' });
    routingEvalApi
      .get(id)
      .then((run) => current && setState({ status: 'ready', run }))
      .catch(
        (failure) =>
          current &&
          setState({
            status: 'error',
            message: failure instanceof Error ? failure.message : 'Run unavailable',
          }),
      );
    return () => {
      current = false;
    };
  }, [id, attempt]);
  return (
    <WideDrawer
      open={summary != null}
      title={summary ? `Routing run: ${summary.name}` : 'Routing run'}
      onClose={onClose}
    >
      {summary && (
        <>
          <p className="muted">Run {formatDateTime(summary.createdAt)}</p>
          {state.status === 'loading' && <Skeleton shape="chart" width="100%" />}
          {state.status === 'error' && (
            <ErrorState
              title="Run unavailable"
              message={state.message}
              onRetry={() => setAttempt((n) => n + 1)}
            />
          )}
          {state.status === 'ready' && <RunBody run={state.run} />}
        </>
      )}
    </WideDrawer>
  );
}
