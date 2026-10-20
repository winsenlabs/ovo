'use client';
import type { ExternalEngine } from '@winsendotai/ovo-contracts';
import { DecimalField, NumberField, SelectField, SwitchField, TagsField, TextField } from '../../../components/routing/fields';
import { InlineAlert } from '../../../components/ui/feedback-v2';
import { useDesigner } from './designer-context';

const CONTEXT_KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** The external decision service: a signed HTTPS webhook answering a branch and a confidence. */
export function ExternalEditor({
  engine,
  onChange,
  id,
}: {
  engine: ExternalEngine;
  onChange: (engine: ExternalEngine) => void;
  id: string;
}) {
  const { status, credentials } = useDesigner();
  const https = engine.endpoint.startsWith('https://') && engine.endpoint.length > 'https://'.length;
  const options = credentials.map((c) => ({ value: c.id, label: c.label }));
  if (engine.credentialId && !options.some((o) => o.value === engine.credentialId))
    options.unshift({ value: engine.credentialId, label: engine.credentialId });
  const badSlots = engine.slots.filter((s) => !CONTEXT_KEY.test(s));
  return (
    <div className="rt-stack">
      {!status.externalEnabled && (
        <InlineAlert tone="warn">
          External services are switched off on this installation, so this engine will not be called
          until they are enabled.
        </InlineAlert>
      )}
      <TextField
        id={`${id}-endpoint`}
        label="Endpoint"
        type="url"
        mono
        value={engine.endpoint}
        placeholder="https://decisions.example.com/route"
        error={https ? undefined : 'The endpoint must be an https address'}
        help="Called once per question with a signed request; redirects and private addresses are refused."
        onChange={(endpoint) => onChange({ ...engine, endpoint })}
      />
      <SelectField
        id={`${id}-credential`}
        label="Signing secret"
        value={engine.credentialId}
        placeholder={options.length ? 'Choose a secret…' : 'No secrets yet'}
        options={options}
        help="The request is signed with this secret so the service can verify it came from here."
        onChange={(credentialId) => onChange({ ...engine, credentialId })}
      />
      <NumberField id={`${id}-timeout`} label="Give up after" unit="ms" min={100} max={5000} value={engine.timeoutMs} onChange={(timeoutMs) => onChange({ ...engine, timeoutMs })} />
      <DecimalField id={`${id}-threshold`} label="Confidence needed" value={engine.threshold} onChange={(threshold) => onChange({ ...engine, threshold })} />
      <fieldset className="queue-section">
        <legend>What is sent</legend>
        <SwitchField label="What the caller said" checked={engine.send.turnText} onChange={(turnText) => onChange({ ...engine, send: { ...engine.send, turnText } })} />
        <SwitchField label="The caller's phone number" checked={engine.send.callerId} help="Off by default: send the least the service needs." onChange={(callerId) => onChange({ ...engine, send: { ...engine.send, callerId } })} />
        <TagsField id={`${id}-variables`} label="Call variables to send" values={engine.send.variables} onChange={(variables) => onChange({ ...engine, send: { ...engine.send, variables } })} />
      </fieldset>
      <TagsField
        id={`${id}-slots`}
        label="Context values the service may set"
        values={engine.slots}
        help="Each becomes a variable the chosen agent can read."
        error={badSlots.length ? `Lowercase letters, digits and _: ${badSlots.join(', ')}` : undefined}
        onChange={(slots) => onChange({ ...engine, slots })}
      />
    </div>
  );
}
