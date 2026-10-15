'use client';
import type { DestinationPolicy } from '../../lib/types/queues';
import { FormSection, SwitchField, TagsField } from './fields';

/** The toll-fraud guard: the third party can only send a caller where this list allows. */
export function DestinationFields({
  value,
  errors,
  onChange,
}: {
  value: DestinationPolicy;
  errors: Record<string, string | undefined>;
  onChange: (value: DestinationPolicy) => void;
}) {
  return (
    <FormSection
      title="Where the third party may send callers"
      description="The answer to the webhook names where to transfer the caller. OVO only dials what matches this list, so a compromised or mistaken answer cannot reach an arbitrary number. At least one number prefix is required."
    >
      <TagsField
        id="queue-dest-prefixes"
        label="Allowed number prefixes"
        values={value.allowE164Prefixes}
        placeholder="+9140"
        help="International format. +91 allows any Indian number; +9140 only that area."
        error={errors['destination.allowE164Prefixes']}
        onChange={(allowE164Prefixes) => onChange({ ...value, allowE164Prefixes })}
      />
      <TagsField
        id="queue-dest-hosts"
        label="Allowed SIP hosts"
        values={value.allowSipHosts}
        placeholder="acd.example.com or .example.com"
        help="An exact host, or a suffix starting with a dot."
        error={errors['destination.allowSipHosts']}
        onChange={(allowSipHosts) => onChange({ ...value, allowSipHosts })}
      />
      <TagsField
        id="queue-dest-headers"
        label="Headers the answer may set"
        values={value.allowedHeaders}
        placeholder="X-Acd-Ticket"
        help="Only names starting with X-. Anything else in the answer is dropped."
        error={errors['destination.allowedHeaders']}
        onChange={(allowedHeaders) => onChange({ ...value, allowedHeaders })}
      />
      <SwitchField
        label="Allow SIP without TLS (sip: instead of sips:)"
        checked={value.allowInsecureSip}
        help="Leave off unless the third party cannot offer TLS."
        onChange={(allowInsecureSip) => onChange({ ...value, allowInsecureSip })}
      />
    </FormSection>
  );
}
