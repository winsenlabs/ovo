'use client';
import type { ContextPolicy } from '../../lib/types/queues';
import { FormSection, NumberField, SwitchField, TagsField } from './fields';

/** What the queue may know about the call. Nothing left off here ever leaves OVO. */
export function ContextFields({
  value,
  kind,
  onChange,
}: {
  value: ContextPolicy;
  kind: 'external' | 'managed';
  onChange: (value: ContextPolicy) => void;
}) {
  const set = <K extends keyof ContextPolicy>(key: K, next: ContextPolicy[K]) =>
    onChange({ ...value, [key]: next });
  const who = kind === 'external' ? 'the third party' : 'the operator';
  return (
    <FormSection
      title="What the queue is told"
      description={`The only caller data ${who} receives. The caller's number and the transcript are off by default for a webhook queue.`}
    >
      <SwitchField label="Caller's number" checked={value.callerId} onChange={(v) => set('callerId', v)} />
      <SwitchField label="Number they dialled" checked={value.calledNumber} onChange={(v) => set('calledNumber', v)} />
      <SwitchField label="Language" checked={value.language} onChange={(v) => set('language', v)} />
      <SwitchField label="Intent" checked={value.intent} onChange={(v) => set('intent', v)} />
      <SwitchField
        label="The AI agent's summary"
        checked={value.summary}
        help="Written by the agent that transferred the call. Treat it as untrusted text."
        onChange={(v) => set('summary', v)}
      />
      <NumberField
        id="queue-ctx-turns"
        label="Transcript turns"
        min={0}
        max={20}
        help="How many of the last turns before the handoff. 0 sends none."
        value={value.transcriptTurns}
        onChange={(v) => set('transcriptTurns', v)}
      />
      <SwitchField label="Link to the transcript" checked={value.transcriptLink} onChange={(v) => set('transcriptLink', v)} />
      {kind === 'external' ? (
        <TagsField
          id="queue-ctx-vars"
          label="Variables to send"
          values={Array.isArray(value.variables) ? value.variables : []}
          placeholder="account_id"
          help="Only variables named here are sent."
          onChange={(v) => set('variables', v)}
        />
      ) : (
        <SwitchField
          label="Show the variables the AI agent declared"
          checked={value.variables === 'declared'}
          onChange={(v) => set('variables', v ? 'declared' : [])}
        />
      )}
    </FormSection>
  );
}
