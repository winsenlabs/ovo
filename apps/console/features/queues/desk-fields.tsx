'use client';
import { RadioCardGroup } from '../../components/ui/choice-card';
import type { ManagedQueueDefinition } from '../../lib/types/queues';
import type { Patch } from './common-fields';
import { FormSection, NumberField, SelectField, SwitchField, TagsField } from '../../components/routing/fields';

/** How operators take calls from a desk queue: assignment, staffing, the AI's role, send-back. */
export function DeskFields({
  draft,
  patch,
  errors,
}: {
  draft: ManagedQueueDefinition;
  patch: Patch;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      <FormSection title="Who answers">
        <RadioCardGroup
          name="queue-assignment"
          groupLabel="Assignment"
          value={draft.assignment}
          onChange={(value) => patch('assignment', value)}
          choices={[
            {
              value: 'OPEN_PICKUP',
              title: 'Open pick-up',
              description: 'Every eligible operator sees the caller; the first to accept takes it.',
            },
            {
              value: 'AUTO_ASSIGN',
              title: 'Auto-assign',
              description: 'OVO offers the caller to one operator at a time, longest idle first.',
            },
          ]}
        />
        <TagsField
          id="queue-teams"
          label="Teams"
          values={draft.teamIds}
          placeholder="support"
          help="Operators in any of these teams take this queue. None means every enabled operator."
          error={errors.teamIds}
          onChange={(value) => patch('teamIds', value)}
        />
        <SelectField
          id="queue-language"
          label="Match the caller's language"
          value={draft.language}
          options={[
            { value: 'prefer', label: 'Prefer operators who speak it' },
            { value: 'require', label: 'Only operators who speak it' },
            { value: 'ignore', label: 'Ignore language' },
          ]}
          onChange={(value) => patch('language', value)}
        />
        <NumberField
          id="queue-offer"
          label="Offer lasts"
          unit="seconds"
          min={5}
          max={120}
          help="Auto-assign only: how long one operator has before it moves to the next."
          error={errors.offerSeconds}
          value={draft.offerSeconds}
          onChange={(value) => patch('offerSeconds', value)}
        />
        <NumberField
          id="queue-join"
          label="Time to join after accepting"
          unit="seconds"
          min={5}
          max={120}
          error={errors.joinSeconds}
          value={draft.joinSeconds}
          onChange={(value) => patch('joinSeconds', value)}
        />
        <SwitchField
          label="Refuse callers when nobody is online"
          checked={draft.requireOnline}
          help="On: the routing falls through to its next step. Off: the caller waits regardless."
          onChange={(value) => patch('requireOnline', value)}
        />
      </FormSection>
      <FormSection title="The AI agent and the call">
        <SelectField
          id="queue-ai"
          label="While an operator is on the call"
          value={draft.ai.mode}
          options={[
            { value: 'transcribe', label: 'Transcribe silently (live captions, transcript)' },
            { value: 'out', label: 'Step out completely' },
          ]}
          onChange={(value) => patch('ai.mode', value)}
        />
        <SwitchField
          label="Transcribe the operator too"
          checked={draft.ai.transcribeOperator}
          onChange={(value) => patch('ai.transcribeOperator', value)}
        />
        <SelectField
          id="queue-leave"
          label="If the operator's browser closes"
          value={draft.onOperatorLeave}
          options={[
            { value: 'end_call', label: 'End the call' },
            { value: 'return_to_agent', label: 'Return the caller to an AI agent' },
          ]}
          onChange={(value) => patch('onOperatorLeave', value)}
        />
        <TagsField
          id="queue-return"
          label="AI agents operators can send callers back to"
          values={draft.returnTargets}
          placeholder="billing-bot"
          help="Transfer target keys from the routing point. None disables the Send back button."
          error={errors.returnTargets}
          onChange={(value) => patch('returnTargets', value)}
        />
        <SwitchField
          label="Require wrap-up after each call"
          checked={draft.wrapUp.required}
          onChange={(value) => patch('wrapUp.required', value)}
        />
        <TagsField
          id="queue-dispositions"
          label="Wrap-up dispositions"
          values={draft.wrapUp.dispositions}
          placeholder="Resolved"
          error={errors['wrapUp.dispositions']}
          onChange={(value) => patch('wrapUp.dispositions', value)}
        />
      </FormSection>
    </>
  );
}
