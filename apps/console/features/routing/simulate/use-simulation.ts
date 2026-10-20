'use client';
import type { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { useCallback, useRef, useState } from 'react';
import { ApiError } from '../../../lib/api';
import { routingApi } from '../../../lib/data/routing-api';
import { buildRequest, formProblem, setAnswer, type SimForm } from '../../../lib/derive/routing-simulate';
import type { RoutingSimulationResult, SimulatedAnswer } from '../../../lib/types/routing-simulate';
import type { RoutingIssue } from '../../../lib/types/routing';

export type SimRun =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; result: RoutingSimulationResult; request: ReturnType<typeof buildRequest> }
  | { status: 'blocked'; blockers: RoutingIssue[]; warnings: RoutingIssue[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'error'; message: string };

/**
 * Runs the simulator for a form. The server answers with the whole path, so the console keeps the
 * request beside the result (a saved eval case is built from both). A refusal for blockers, a
 * missing live engine or a rate limit is its own state, not a failure to retry blindly.
 */
export function useSimulation(options: { timeZone?: string; draft?: RoutingPointDraft }) {
  const [run, setRun] = useState<SimRun>({ status: 'idle' });
  const latest = useRef(0);
  const execute = useCallback(
    async (form: SimForm) => {
      const problem = formProblem(form);
      if (problem) return setRun({ status: 'error', message: problem });
      const mine = ++latest.current;
      setRun({ status: 'running' });
      const request = buildRequest(form, options);
      try {
        const result = await routingApi.simulate(request);
        if (latest.current === mine) setRun({ status: 'done', result, request });
      } catch (failure) {
        if (latest.current !== mine) return;
        if (failure instanceof ApiError && failure.code === 'routing_simulate_blocked')
          setRun({ status: 'blocked', blockers: (failure.details?.blockers as RoutingIssue[]) ?? [], warnings: (failure.details?.warnings as RoutingIssue[]) ?? [] });
        else if (failure instanceof ApiError && failure.code === 'simulate_live_unavailable')
          setRun({ status: 'unavailable', reason: failure.message });
        else if (failure instanceof ApiError && failure.status === 429)
          setRun({ status: 'error', message: 'Too many simulations. Wait a moment and run again.' });
        else setRun({ status: 'error', message: failure instanceof Error ? failure.message : 'The simulation failed.' });
      }
    },
    [options.draft, options.timeZone], // eslint-disable-line react-hooks/exhaustive-deps
  );
  return { run, execute, reset: () => setRun({ status: 'idle' }) };
}

/** The form with one more scripted answer for a node's engine. */
export function withAnswer(form: SimForm, answer: SimulatedAnswer): SimForm {
  return { ...form, answers: setAnswer(form.answers, answer, answer) };
}
