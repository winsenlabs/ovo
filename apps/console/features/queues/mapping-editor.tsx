'use client';
import { useState } from 'react';
import { JsonEditor } from '../../components/forms/json-editor';
import { InlineAlert } from '../../components/ui/feedback-v2';
import { Select } from '../../components/ui/inputs';
import { availableContextFields } from '../../lib/derive/queues';
import type { ContextPolicy, WebhookSpec } from '../../lib/types/queues';
import { FormSection, SwitchField } from '../../components/routing/fields';
import { useMappingPreview } from './use-mapping-preview';

const STARTER = {
  callId: { $from: 'call.id' },
  language: { $from: 'route.language', default: 'en' },
  replyTo: { $from: 'ticket.callbackUrl' },
};

/**
 * The request body: OVO's standard format by default, or a mapping from call fields to whatever
 * the third party expects. Only fields the "what the queue is told" switches allow can be picked.
 */
export function MappingEditor({
  spec,
  policy,
  onChange,
}: {
  spec: WebhookSpec;
  policy: ContextPolicy;
  onChange: (spec: WebhookSpec) => void;
}) {
  const custom = spec.body !== undefined;
  const preview = useMappingPreview(spec, policy, custom);
  const [picked, setPicked] = useState('');
  const fields = availableContextFields(policy);
  const insert = () => {
    if (!picked || !spec.body) return;
    const name = picked.split('.').at(-1)!;
    onChange({ ...spec, body: { ...spec.body, [name]: { $from: picked } } });
    setPicked('');
  };
  return (
    <FormSection
      title="Request body"
      description="Standard format: ovo.human-queue/1, with the ticket, queue, call, route, handover and links."
    >
      <SwitchField
        label="Map the fields myself"
        checked={custom}
        onChange={(on) => onChange({ ...spec, body: on ? structuredClone(STARTER) : undefined })}
      />
      {custom && (
        <>
          <div className="queue-picker">
            <label htmlFor="queue-field-picker" className="sr-only">
              Call field to insert
            </label>
            <Select
              id="queue-field-picker"
              value={picked}
              placeholder="Insert a call field…"
              options={fields.map((field) => ({
                value: field.path,
                label: `${field.label} (${field.path})`,
              }))}
              onChange={setPicked}
            />
            <button type="button" className="button" disabled={!picked} onClick={insert}>
              Insert
            </button>
          </div>
          <label htmlFor="queue-body-mapping">Mapping (JSON)</label>
          <JsonEditor
            id="queue-body-mapping"
            value={spec.body}
            onValid={(body) => onChange({ ...spec, body: body as Record<string, unknown> })}
          />
          <small className="muted">
            Use {'{ "$from": "caller.number", "default": "" }'} for a field and{' '}
            {'{ "$template": "Call about {{route.intent}}" }'} for text.
          </small>
          <div aria-live="polite" className="queue-preview">
            <h4>Preview</h4>
            {preview.status === 'loading' && <p className="muted">Rendering…</p>}
            {preview.status === 'error' && (
              <InlineAlert tone="danger">{preview.message}</InlineAlert>
            )}
            {preview.status === 'ready' && (
              <>
                {preview.result.issues.map((issue, index) => (
                  <InlineAlert key={index} tone="danger">
                    {issue.path.join('.') ? `${issue.path.join('.')}: ` : ''}
                    {issue.message}
                  </InlineAlert>
                ))}
                {preview.result.body !== undefined && (
                  <pre className="mono ds-code-pre" tabIndex={0}>
                    {JSON.stringify(preview.result.body, null, 2)}
                  </pre>
                )}
              </>
            )}
          </div>
        </>
      )}
    </FormSection>
  );
}
