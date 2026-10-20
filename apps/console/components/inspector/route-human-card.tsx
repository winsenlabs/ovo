'use client';
import { KeyValueGrid, SectionCard } from '../ui/section-card';
import { StatusBadgeV2 } from '../ui/status-badge';
import { InlineAlert } from '../ui/feedback-v2';
import { Duration } from '../ui/display';
import { humaniseEnum, type Tone } from '../../lib/status';
import type { HumanSummary } from '../../lib/derive/call-route-summary';

const OUTCOME_TONE: Record<string, Tone> = {
  connected: 'ok',
  handed_off: 'ok',
  returned: 'warn',
  ended: 'neutral',
  caller_hangup: 'neutral',
  abandoned: 'warn',
  timeout: 'danger',
  rejected: 'danger',
  unavailable: 'danger',
  failed: 'danger',
};

function callbackChips(callbacks: HumanSummary['callbacks']) {
  const seen = [
    callbacks.accepted && 'Accepted',
    callbacks.released && 'Released',
    callbacks.outcome && `Outcome: ${humaniseEnum(callbacks.outcome)}`,
  ].filter(Boolean) as string[];
  return seen.length ? (
    <span className="ui-cluster">
      {seen.map((label) => (
        <span key={label} className="ds-chip">
          {label}
        </span>
      ))}
    </span>
  ) : null;
}

/** The person segment: which queue, how long the caller waited and talked, who answered. */
export function HumanCard({ human }: { human: HumanSummary }) {
  return (
    <SectionCard
      id="route-human"
      title="Person"
      description="A human operator handled part of this call. No caller number, destination or summary is shown here."
    >
      <KeyValueGrid
        columns={3}
        items={[
          { label: 'Queue', value: human.queue, mono: true },
          { label: 'Kind', value: humaniseEnum(human.kind) },
          { label: 'Waited', value: human.waitMs == null ? null : <Duration ms={human.waitMs} /> },
          { label: 'Talked', value: human.talkMs == null ? null : <Duration ms={human.talkMs} /> },
          { label: 'Operator', value: human.operator, mono: true },
          {
            label: 'Outcome',
            value: human.outcome ? (
              <StatusBadgeV2
                size="sm"
                tone={OUTCOME_TONE[human.outcome] ?? 'neutral'}
                label={humaniseEnum(human.outcome)}
              />
            ) : null,
          },
          { label: 'Third-party callbacks', value: callbackChips(human.callbacks) },
        ]}
      />
      {human.refusals.length > 0 && (
        <InlineAlert tone="info">
          Earlier requests were refused: {human.refusals.map(humaniseEnum).join(', ')}.
        </InlineAlert>
      )}
    </SectionCard>
  );
}
