'use client';
import { DEFAULT_QUESTION, type Policy } from './decision-shapes';
import { starterFlow } from './flow-shapes';
import { UnconfiguredPanel } from './unconfigured-panel';

const base = (): Omit<Policy, 'questions'> => ({
  enabled: true,
  state: { sources: ['last-turn'], transcriptTurns: 6 },
  timeoutMs: 800,
});

/**
 * No decision policy yet. Agent mode chooses between flat questions (asked on every turn) and a
 * state-aware flow (one listen set per turn); a script can only widen the matching of its own
 * transitions (AGT-14), so that is the one thing it is offered.
 */
export function DecisionStart({
  scripted,
  setPolicy,
}: {
  scripted: boolean;
  setPolicy: (next: Policy) => void;
}) {
  return scripted ? (
    <UnconfiguredPanel
      labelledBy="decision-title"
      title="Decision model"
      emptyTitle="Exact matches only"
      action={
        <button
          className="button primary"
          type="button"
          onClick={() => setPolicy({ ...base(), questions: [] })}
        >
          Match replies with the decision model
        </button>
      }
    >
      The script moves only on the exact replies written on its transitions. The decision model can
      also match replies that mean the same thing (&ldquo;haan, bhej do&rdquo; for
      &ldquo;yes&rdquo;). It never invents a path the script does not have.
    </UnconfiguredPanel>
  ) : (
    <UnconfiguredPanel
      labelledBy="decision-title"
      title="Decision model"
      emptyTitle="No decision questions"
      action={
        <div className="button-row">
          <button
            className="button primary"
            type="button"
            onClick={() => setPolicy({ ...base(), questions: [DEFAULT_QUESTION()] })}
          >
            Add a decision question
          </button>
          <button
            className="button"
            type="button"
            onClick={() => setPolicy({ ...base(), questions: [], flow: starterFlow() })}
          >
            Start a conversation flow
          </button>
        </div>
      }
    >
      A decision model answers a fixed question with a calibrated confidence, so a confident turn
      needs no LLM call at all. Below the confidence you set, the turn falls back. A conversation
      flow goes further: it knows which state the call is in and asks only what fits there.
    </UnconfiguredPanel>
  );
}
