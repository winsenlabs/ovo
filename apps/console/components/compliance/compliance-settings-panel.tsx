'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest, ApiError } from '../../lib/api';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';
import { failureText, type ComplianceSettings, type SettingsRecord } from './compliance-types';

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? '')
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

/** The settings the form edits, merged over everything else the workspace has set. */
export function settingsFromForm(
  current: ComplianceSettings,
  values: FormData,
): ComplianceSettings {
  const text = (name: string) => String(values.get(name) ?? '').trim();
  const intimation = ['submittedAt', 'oap', 'objective', 'documentRef'].map((key) => text(key));
  return {
    ...current,
    sender: {
      regulator: text('regulator') || 'other',
      ...(text('legalName') ? { legalName: text('legalName') } : {}),
      ...(text('dltPrincipalEntityId')
        ? { dltPrincipalEntityId: text('dltPrincipalEntityId') }
        : {}),
    },
    ...(intimation.every(Boolean)
      ? {
          autodialerIntimation: {
            submittedAt: intimation[0]!,
            oap: intimation[1]!,
            objective: intimation[2]!,
            documentRef: intimation[3]!,
          },
        }
      : { autodialerIntimation: undefined }),
    enforcement: {
      ...current.enforcement,
      series: text('series') as 'refuse' | 'warn',
      a2pDeclarationRequiredFrom: text('a2pDeclarationRequiredFrom'),
      abandonedBreaker: text('abandonedBreaker') as 'enforce' | 'monitor',
    },
    optOutScope: text('optOutScope') as 'all' | 'promotional',
    testNumbers: lines(values.get('testNumbers')),
    blackout: { ...current.blackout, dates: lines(values.get('blackoutDates')) },
    complaintSla: {
      ...current.complaintSla,
      ackHours: Number(text('ackHours')),
      resolveDays: Number(text('resolveDays')),
    },
  };
}

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
  const [message, setMessage] = useState<{ tone: 'neutral' | 'danger'; text: string }>();
  const { settings } = record;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const next = settingsFromForm(settings, new FormData(event.currentTarget));
      await apiRequest('/operations/compliance/settings', {
        method: 'PUT',
        body: JSON.stringify({ expectedVersion: record.version, settings: next }),
      });
      setMessage({ tone: 'neutral', text: 'Saved.' });
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
    <Panel labelledBy="compliance-settings-title">
      <PanelHeader
        id="compliance-settings-title"
        title="Sender and enforcement"
        badge={<StatusBadge>{`${record.rulePack.id} ${record.rulePack.version}`}</StatusBadge>}
      >
        <small>
          Conservative defaults, not legal advice. See docs/runbooks/trai-compliance.md for each
          decision point.
        </small>
      </PanelHeader>
      {!intimation && (
        <Notice tone="warning">
          No autodialler intimation is on file, so no +91 number is dialed except test numbers.
        </Notice>
      )}
      <form className="panel-body form-grid" onSubmit={save} key={record.version}>
        <fieldset disabled={!canEdit} className="form-grid">
          <Field label="Legal name" htmlFor="cs-legal-name">
            <input id="cs-legal-name" name="legalName" defaultValue={settings.sender.legalName} />
          </Field>
          <Field label="DLT principal entity ID" htmlFor="cs-pe">
            <input
              id="cs-pe"
              name="dltPrincipalEntityId"
              defaultValue={settings.sender.dltPrincipalEntityId}
            />
          </Field>
          <Field
            label="Regulator"
            htmlFor="cs-regulator"
            help="Picks the designated series for service calls (RBI, SEBI, IRDAI, PFRDA, Government: 1600; utilities, logistics: 1601)."
          >
            <select id="cs-regulator" name="regulator" defaultValue={settings.sender.regulator}>
              {[
                'rbi',
                'sebi',
                'irdai',
                'pfrda',
                'government',
                'utilities',
                'logistics',
                'other',
              ].map((value) => (
                <option key={value} value={value}>
                  {value.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Intimation submitted" htmlFor="cs-int-date">
            <input
              id="cs-int-date"
              name="submittedAt"
              type="date"
              defaultValue={intimation?.submittedAt}
            />
          </Field>
          <Field label="Telco (OAP)" htmlFor="cs-int-oap">
            <input id="cs-int-oap" name="oap" defaultValue={intimation?.oap} />
          </Field>
          <Field label="Stated objective" htmlFor="cs-int-objective">
            <input id="cs-int-objective" name="objective" defaultValue={intimation?.objective} />
          </Field>
          <Field label="Intimation reference" htmlFor="cs-int-ref">
            <input id="cs-int-ref" name="documentRef" defaultValue={intimation?.documentRef} />
          </Field>
          <Field
            label="Caller number outside its series"
            htmlFor="cs-series"
            help="Refuse is the safe default; warn dials and records the warning (open question Q11)."
          >
            <select id="cs-series" name="series" defaultValue={settings.enforcement.series}>
              <option value="refuse">Refuse the call</option>
              <option value="warn">Dial and record a warning</option>
            </select>
          </Field>
          <Field
            label="A2P declarations required from"
            htmlFor="cs-a2p"
            help="Third Amendment Reg 4 (about 17 Nov 2026); only an earlier date is accepted."
          >
            <input
              id="cs-a2p"
              name="a2pDeclarationRequiredFrom"
              type="date"
              defaultValue={settings.enforcement.a2pDeclarationRequiredFrom}
            />
          </Field>
          <Field label="Abandoned-call breaker" htmlFor="cs-breaker">
            <select
              id="cs-breaker"
              name="abandonedBreaker"
              defaultValue={settings.enforcement.abandonedBreaker}
            >
              <option value="enforce">Pause campaigns at 3%</option>
              <option value="monitor">Report only</option>
            </select>
          </Field>
          <Field label="An in-call opt-out stops" htmlFor="cs-optout">
            <select id="cs-optout" name="optOutScope" defaultValue={settings.optOutScope}>
              <option value="all">Every call to the number</option>
              <option value="promotional">Promotional calls only</option>
            </select>
          </Field>
          <Field
            label="Test numbers (one per line)"
            htmlFor="cs-test"
            help="Your own phones: category, series, A2P, consent and DND checks are skipped; caps, windows and the do-not-call list still apply."
          >
            <textarea
              id="cs-test"
              name="testNumbers"
              rows={3}
              defaultValue={settings.testNumbers.join('\n')}
            />
          </Field>
          <Field
            label="Blackout dates"
            htmlFor="cs-blackout"
            help={`YYYY-MM-DD or MM-DD; applies to ${settings.blackout.appliesTo.join(', ')}.`}
          >
            <textarea
              id="cs-blackout"
              name="blackoutDates"
              rows={3}
              defaultValue={settings.blackout.dates.join('\n')}
            />
          </Field>
          <Field label="Acknowledge complaints within (hours)" htmlFor="cs-ack">
            <input
              id="cs-ack"
              name="ackHours"
              type="number"
              min={1}
              max={720}
              defaultValue={settings.complaintSla.ackHours}
            />
          </Field>
          <Field label="Resolve complaints within (days)" htmlFor="cs-resolve">
            <input
              id="cs-resolve"
              name="resolveDays"
              type="number"
              min={1}
              max={90}
              defaultValue={settings.complaintSla.resolveDays}
            />
          </Field>
          <button className="button primary align-start">Save settings</button>
        </fieldset>
      </form>
      {message && (
        <Notice tone={message.tone} live>
          {message.text}
        </Notice>
      )}
    </Panel>
  );
}
