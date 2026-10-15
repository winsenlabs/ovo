'use client';
import { useState } from 'react';
import { ChoiceCardDemo } from './choice-card-demo';
import { Money } from '../../../components/ui/display';
import {
  EmptyStateV2,
  ErrorState,
  InlineAlert,
  Skeleton,
} from '../../../components/ui/feedback-v2';
import { FileDrop, NumberInput, TagInput } from '../../../components/ui/inputs';
import { KeyValueGrid, SectionCard } from '../../../components/ui/section-card';
import { Stepper } from '../../../components/ui/stepper';
import { Switch } from '../../../components/ui/display';

/** Empty/error/alert/skeleton, stepper + choice cards, and the remaining form controls. */
export function FeedbackAndFormSections() {
  const [tags, setTags] = useState<readonly string[]>(['billing', 'kyc']);
  const [switchOn, setSwitchOn] = useState(true);
  const [number, setNumber] = useState<number | null>(12);

  return (
    <>
      <SectionCard title="Empty / error / inline alert / skeleton">
        <div className="ds-kpi-strip">
          <EmptyStateV2 variant="first-run" title="No agents yet">
            Create your first agent to see it here.
          </EmptyStateV2>
          <EmptyStateV2
            variant="unavailable"
            title="Not configured on this installation"
            secondaryHref="#"
            secondaryLabel="Docs"
          />
          <ErrorState
            message="The performance API returned a 503."
            onRetry={() => undefined}
            requestCode="req_91a"
          />
        </div>
        <InlineAlert tone="warn">This credential expires in 9 days.</InlineAlert>
        <Skeleton shape="line" />
      </SectionCard>

      <SectionCard title="Stepper + choice cards">
        <Stepper
          steps={[
            { label: 'Basics', state: 'done' },
            { label: 'Plugins', state: 'current' },
            { label: 'Behavior', state: 'upcoming' },
          ]}
        />
        <ChoiceCardDemo />
      </SectionCard>

      <SectionCard title="Form controls">
        <div className="ds-kpi-strip">
          <Switch checked={switchOn} onChange={setSwitchOn} label="Enabled" />
          <NumberInput value={number} onChange={setNumber} unit="seconds" ariaLabel="Delay" />
          <TagInput values={tags} onChange={setTags} placeholder="Add a tag" />
        </div>
        <FileDrop accept=".csv" onFile={() => undefined} hint="Drop a CSV or click to browse" />
      </SectionCard>

      <SectionCard title="Money / currency">
        <KeyValueGrid
          items={[
            { label: 'INR', value: <Money minorUnits={1734050} currency="INR" /> },
            {
              label: 'USD (provisional)',
              value: <Money minorUnits={1200} currency="USD" provisional />,
            },
          ]}
        />
      </SectionCard>
    </>
  );
}
