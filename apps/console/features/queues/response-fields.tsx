'use client';
import type { WebhookResponseMapping } from '../../lib/types/queues';
import { FormSection, TagsField, TextField } from '../../components/routing/fields';

/** How to read the third party's answer. All paths are RFC 6901 JSON pointers, blank for the default. */
export function ResponseFields({
  value,
  errors,
  onChange,
}: {
  value: WebhookResponseMapping;
  errors: Record<string, string | undefined>;
  onChange: (value: WebhookResponseMapping) => void;
}) {
  const pointer = (
    key:
      | 'statusPath'
      | 'ticketRefPath'
      | 'destinationE164Path'
      | 'destinationSipUriPath'
      | 'destinationHeadersPath',
    label: string,
    placeholder: string,
  ) => (
    <TextField
      id={`queue-response-${key}`}
      label={label}
      mono
      value={value[key] ?? ''}
      placeholder={placeholder}
      error={errors[`webhook.response.${key}`]}
      onChange={(next) => onChange({ ...value, [key]: next || undefined })}
    />
  );
  return (
    <FormSection
      title="Reading the answer"
      description="Leave the paths blank if the third party replies in OVO's standard format ({ status, destination })."
    >
      {pointer('statusPath', 'Status field', '/result')}
      <TagsField
        id="queue-accepted"
        label="Values meaning accepted"
        values={value.acceptedValues}
        onChange={(acceptedValues) => onChange({ ...value, acceptedValues })}
      />
      <TagsField
        id="queue-queued"
        label="Values meaning queued"
        values={value.queuedValues}
        onChange={(queuedValues) => onChange({ ...value, queuedValues })}
      />
      <TagsField
        id="queue-rejected"
        label="Values meaning rejected"
        values={value.rejectedValues}
        onChange={(rejectedValues) => onChange({ ...value, rejectedValues })}
      />
      {pointer('ticketRefPath', 'Their reference field', '/ticket/id')}
      {pointer('destinationE164Path', 'Phone number field', '/dial/number')}
      {pointer('destinationSipUriPath', 'SIP address field', '/dial/uri')}
      {pointer('destinationHeadersPath', 'SIP headers field', '/dial/headers')}
    </FormSection>
  );
}
