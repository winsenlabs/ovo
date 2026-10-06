'use client';
import { useState } from 'react';
import { Field } from '../primitives';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * The campaign's `callingWindow` from the create form: absent keeps the release's calling hours
 * (or none), judged in the campaign's schedule timezone when set here.
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

/** Calling hours for one campaign; the release's own hours apply unless they are set here. */
export function CampaignCallingWindow({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<'release' | 'campaign'>('release');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('19:00');
  return (
    <fieldset className="nested-card" disabled={disabled}>
      <legend>Calling hours</legend>
      <Field
        label="Window"
        htmlFor="campaign-window-mode"
        help="Admission waits outside the window; a call admitted just before it closes is requeued, not dialed."
      >
        <select
          id="campaign-window-mode"
          name="callingWindowMode"
          value={mode}
          onChange={(event) => setMode(event.target.value as 'release' | 'campaign')}
        >
          <option value="release">Use the agent&rsquo;s calling hours</option>
          <option value="campaign">Set hours for this campaign</option>
        </select>
      </Field>
      {mode === 'campaign' && (
        <div className="form-grid">
          <Field label="From" htmlFor="campaign-window-start">
            <input
              id="campaign-window-start"
              name="callingWindowStart"
              type="time"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              required
            />
          </Field>
          <Field
            label="Until (exclusive)"
            htmlFor="campaign-window-end"
            help="In the campaign's IANA timezone."
            error={start >= end ? 'End must be after start.' : undefined}
          >
            <input
              id="campaign-window-end"
              name="callingWindowEnd"
              type="time"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              required
            />
          </Field>
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
