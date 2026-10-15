'use client';
import { useState } from 'react';
import { FormField } from '../ui/form-field';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The campaign's `callingWindow` from the create form: absent keeps the release's calling hours;
 * set here, it narrows them (never widens them), judged in IST for +91 numbers and in the
 * campaign's schedule timezone otherwise.
 */
export function callingWindowBody(values: FormData): {
  callingWindow?: { start: string; end: string; days?: number[] };
} {
  if (values.get('callingWindowMode') !== 'campaign') return {};
  const days = values
    .getAll('callingWindowDays')
    .map(Number)
    .sort((a, b) => a - b);
  return {
    callingWindow: {
      start: String(values.get('callingWindowStart')),
      end: String(values.get('callingWindowEnd')),
      ...(days.length < 7 ? { days } : {}),
    },
  };
}

/** The consent basis the campaign relies on; absent takes the category's default. */
export function campaignComplianceBody(values: FormData): {
  compliance?: { consentBasis: string };
} {
  const consentBasis = String(values.get('consentBasis') ?? '');
  return consentBasis ? { compliance: { consentBasis } } : {};
}

const CONSENT_BASES = [
  ['', 'Category default (service: existing relationship)'],
  ['inferred_relationship', 'Existing customer relationship (service)'],
  ['explicit_service_7d', 'Explicit consent, 7 days (service)'],
  ['inquiry_7d', 'Customer inquiry within 7 days (service)'],
  ['application_3m', 'Application within 3 months (service)'],
  ['explicit_registered', 'Registered explicit consent (promotional)'],
  ['preference_allows', 'Fresh DND scrub allows it (promotional)'],
  ['transaction_30min', 'Within 30 minutes of a transaction'],
] as const;

/**
 * Calling hours and consent for one campaign. The agent's hours and the legal floor always apply;
 * hours set here narrow them, and the server refuses a window that would widen either.
 */
export function CampaignCallingWindow({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<'release' | 'campaign'>('release');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('19:00');
  return (
    <fieldset className="stack" disabled={disabled}>
      <legend className="eyebrow">Calling hours and consent</legend>
      <FormField
        id="campaign-window-mode"
        label="Window"
        help="Calls to +91 numbers are judged in IST against the agent's hours and the legal floor (promotional 10:00–21:00, RBI recovery 08:00–19:00). Admission waits outside them."
      >
        {(control) => (
          <select
            {...control}
            name="callingWindowMode"
            value={mode}
            onChange={(event) => setMode(event.target.value as 'release' | 'campaign')}
          >
            <option value="release">Use the agent&rsquo;s calling hours</option>
            <option value="campaign">Narrow the hours for this campaign</option>
          </select>
        )}
      </FormField>
      <FormField
        id="campaign-consent-basis"
        label="Consent basis"
        help="What makes these calls lawful (TCCCPR). Explicit consent and inquiries need records on the Compliance page."
      >
        {(control) => (
          <select {...control} name="consentBasis" defaultValue="">
            {CONSENT_BASES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {mode === 'campaign' && (
        <div className="form-grid">
          <FormField id="campaign-window-start" label="From">
            {(control) => (
              <input
                {...control}
                name="callingWindowStart"
                type="time"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                required
              />
            )}
          </FormField>
          <FormField
            id="campaign-window-end"
            label="Until (exclusive)"
            help="In IST for +91 numbers; otherwise in the campaign's timezone."
            error={start >= end ? 'End must be after start.' : undefined}
          >
            {(control) => (
              <input
                {...control}
                name="callingWindowEnd"
                type="time"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                required
              />
            )}
          </FormField>
          <fieldset className="field">
            <legend>Days</legend>
            <div className="button-row">
              {WEEKDAYS.map((label, index) => (
                <label key={label} className="toggle-row">
                  <input
                    type="checkbox"
                    name="callingWindowDays"
                    value={index + 1}
                    defaultChecked={index < 6}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      )}
    </fieldset>
  );
}
