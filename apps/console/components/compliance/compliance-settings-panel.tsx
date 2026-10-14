'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { settingsFromForm } from './compliance-settings-form';
import { ComplianceSettingsEnforcementFields } from './compliance-settings-fields-enforcement';
import { failureText, type SettingsRecord } from './compliance-types';

const REGULATORS = [
  'rbi',
  'sebi',
  'irdai',
  'pfrda',
  'government',
  'utilities',
  'logistics',
  'other',
];

/** Who the sender is and how strictly the rule pack is enforced (admins edit, all can read). */
export function ComplianceSettingsPanel({
  record,
  canEdit,
  onSaved,
}: {
  record: SettingsRecord;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const [message, setMessage] = useState<{ tone: 'info' | 'danger'; text: string }>();
  const { settings } = record;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const next = settingsFromForm(settings, new FormData(event.currentTarget));
      await apiRequest('/operations/compliance/settings', {
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: record.version, settings: next }),
      });
      setMessage({ tone: 'info', text: 'Saved.' });
      await onSaved();
    } catch (failure) {
      const conflict = failure instanceof ApiError && failure.status === 409;
      setMessage({
        tone: 'danger',
        text: conflict
          ? 'Someone else changed these settings; they were reloaded.'
          : failureText(failure, 'Settings could not be saved.'),
      });
      if (conflict) await onSaved();
    }
  }
  const intimation = settings.autodialerIntimation;
  return (
    <div className="stack">
      <p className="muted">
        Conservative defaults, not legal advice. See docs/runbooks/trai-compliance.md for each
        decision point.
      </p>
      {!canEdit && <InlineAlert tone="info">Read-only for your role.</InlineAlert>}
      {!intimation && (
        <InlineAlert tone="warn">
          No autodialler intimation is on file, so no +91 number is dialed except test numbers.
        </InlineAlert>
      )}
      {/* One outer `disabled` fieldset: HTML cascades it to every nested fieldset and control, so
          neither this file nor the enforcement-fields split needs to repeat the check. */}
      <form className="stack" onSubmit={save} key={record.version}>
        <fieldset disabled={!canEdit} className="stack">
          <fieldset className="stack">
            <legend className="eyebrow">Sender</legend>
            <div className="form-grid">
              <FormField id="cs-legal-name" label="Legal name">
                {(control) => (
                  <input {...control} name="legalName" defaultValue={settings.sender.legalName} />
                )}
              </FormField>
              <FormField id="cs-pe" label="DLT principal entity ID">
                {(control) => (
                  <input
                    {...control}
                    name="dltPrincipalEntityId"
                    defaultValue={settings.sender.dltPrincipalEntityId}
                  />
                )}
              </FormField>
              <FormField
                id="cs-regulator"
                label="Regulator"
                help="Picks the designated series for service calls (RBI, SEBI, IRDAI, PFRDA, Government: 1600; utilities, logistics: 1601)."
              >
                {(control) => (
                  <select {...control} name="regulator" defaultValue={settings.sender.regulator}>
                    {REGULATORS.map((value) => (
                      <option key={value} value={value}>
                        {value.toUpperCase()}
                      </option>
                    ))}
                  </select>
                )}
              </FormField>
            </div>
          </fieldset>
          <fieldset className="stack">
            <legend className="eyebrow">Autodialer intimation</legend>
            <div className="form-grid">
              <FormField id="cs-int-date" label="Intimation submitted">
                {(control) => (
                  <input
                    {...control}
                    name="submittedAt"
                    type="date"
                    defaultValue={intimation?.submittedAt}
                  />
                )}
              </FormField>
              <FormField id="cs-int-oap" label="Telco (OAP)">
                {(control) => <input {...control} name="oap" defaultValue={intimation?.oap} />}
              </FormField>
              <FormField id="cs-int-objective" label="Stated objective">
                {(control) => (
                  <input {...control} name="objective" defaultValue={intimation?.objective} />
                )}
              </FormField>
              <FormField id="cs-int-ref" label="Intimation reference">
                {(control) => (
                  <input {...control} name="documentRef" defaultValue={intimation?.documentRef} />
                )}
              </FormField>
            </div>
          </fieldset>
          <ComplianceSettingsEnforcementFields settings={settings} />
          <div className="ds-card-footer">
            <button className="button primary">Save settings</button>
            {message && <InlineAlert tone={message.tone}>{message.text}</InlineAlert>}
          </div>
        </fieldset>
      </form>
    </div>
  );
}
