'use client';
import { useEffect, useState } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type { CampaignRecord } from '../../lib/operator-api';
import { JsonEditor } from '../forms/json-editor';
import { Field, Notice, Panel, PanelHeader, StatusBadge } from '../primitives';

export interface CampaignContact {
  id: string;
  sourceRow: number;
  phoneNumber: string;
  externalId?: string;
  variables: Record<string, string>;
  state: string;
}

type DryRun = {
  dryRun: true;
  to: string;
  fromNumber: string;
  variables: string[];
  callingWindow: { start: string; end: string; timezone: string; days?: number[] } | null;
  carrierId: string;
};
type Launch = { callId: string; status: string };

const newOperationId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `test-call-${Date.now()}`;

/** A contact's number with all but the last four digits hidden, for the picker. */
export function maskedNumber(phoneNumber: string): string {
  return phoneNumber.length > 4
    ? `${phoneNumber.slice(0, 3)}•••${phoneNumber.slice(-4)}`
    : phoneNumber;
}

/**
 * "Test call with this customer": a campaign contact's variables (or typed ones) on the campaign's
 * release, dialed to a test number through the same path as a live call, so do-not-call, calling
 * hours, variable validation and carrier checks all apply. "Check" runs them all and dials nothing.
 */
export function TestCallPanel({
  role,
  campaigns,
}: {
  role: SessionIdentity['role'];
  campaigns: readonly CampaignRecord[];
}) {
  const [campaignId, setCampaignId] = useState('');
  const [contacts, setContacts] = useState<CampaignContact[]>([]);
  const [contactId, setContactId] = useState('');
  const [variables, setVariables] = useState<Record<string, unknown>>({});
  const [to, setTo] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: 'dry'; data: DryRun }
    | { kind: 'launched'; data: Launch }
    | { kind: 'error'; text: string }
  >();
  const campaign = campaigns.find((row) => row.id === campaignId);
  useEffect(() => {
    setContacts([]);
    setContactId('');
    if (!campaignId || role !== 'admin') return;
    setFromNumber(campaigns.find((row) => row.id === campaignId)?.fromNumber ?? '');
    apiRequest<unknown>(`/operations/campaigns/${campaignId}/contacts?limit=100`)
      .then(({ data }) => setContacts(items<CampaignContact>(data)))
      .catch((failure) =>
        setResult({
          kind: 'error',
          text: failure instanceof Error ? failure.message : 'Contacts unavailable.',
        }),
      );
  }, [campaignId, campaigns, role]);

  async function submit(dryRun: boolean) {
    if (!campaign) return;
    setBusy(true);
    setResult(undefined);
    try {
      const { data } = await apiRequest<DryRun | Launch>('/calls', {
        method: 'POST',
        body: JSON.stringify({
          operationId: newOperationId(),
          releaseId: campaign.agentReleaseId,
          fromNumber,
          to,
          variables,
          dryRun,
        }),
      });
      setResult(
        dryRun ? { kind: 'dry', data: data as DryRun } : { kind: 'launched', data: data as Launch },
      );
    } catch (failure) {
      setResult({
        kind: 'error',
        text: failure instanceof Error ? failure.message : 'The test call was refused.',
      });
    } finally {
      setBusy(false);
    }
  }

  if (role !== 'admin') return null;
  return (
    <Panel labelledBy="test-call-title">
      <PanelHeader
        id="test-call-title"
        title="Test call with a customer's data"
        badge={<StatusBadge tone="warning">Dials your test number</StatusBadge>}
      />
      <div className="panel-body stack">
        <div className="muted">
          The agent speaks to your test number exactly as it would to this customer: their
          variables, the campaign&rsquo;s release, and every compliance check. The customer is never
          dialed.
        </div>
        <div className="form-grid">
          <Field label="Campaign" htmlFor="test-call-campaign">
            <select
              id="test-call-campaign"
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
            >
              <option value="">Select campaign</option>
              {campaigns.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Customer"
            htmlFor="test-call-contact"
            help="Or leave unselected and type the variables below."
          >
            <select
              id="test-call-contact"
              value={contactId}
              disabled={!contacts.length}
              onChange={(event) => {
                setContactId(event.target.value);
                const contact = contacts.find((row) => row.id === event.target.value);
                setVariables(contact ? { ...contact.variables } : {});
              }}
            >
              <option value="">Type variables</option>
              {contacts.map((contact) => (
                <option key={contact.id} value={contact.id}>
                  Row {contact.sourceRow}
                  {contact.externalId ? ` · ${contact.externalId}` : ''} ·{' '}
                  {maskedNumber(contact.phoneNumber)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Test number to dial" htmlFor="test-call-to">
            <input
              id="test-call-to"
              type="tel"
              placeholder="+91…"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              required
            />
          </Field>
          <Field label="Permitted from number" htmlFor="test-call-from">
            <input
              id="test-call-from"
              type="tel"
              value={fromNumber}
              onChange={(event) => setFromNumber(event.target.value)}
              required
            />
          </Field>
        </div>
        <Field
          label="Call variables"
          htmlFor="test-call-variables"
          help="Checked against the release's declared variables before anything is dialed."
        >
          <JsonEditor
            key={contactId || 'typed'}
            id="test-call-variables"
            value={variables}
            onValid={(value) => setVariables(value as Record<string, unknown>)}
          />
        </Field>
        <div className="button-row">
          <button
            className="button"
            type="button"
            disabled={busy || !campaign || !to || !fromNumber}
            onClick={() => void submit(true)}
          >
            Check without dialing
          </button>
          <button
            className="button primary"
            type="button"
            disabled={busy || !campaign || !to || !fromNumber}
            onClick={() => void submit(false)}
          >
            {busy ? 'Submitting…' : 'Dial test number'}
          </button>
        </div>
        <div aria-live="polite">
          {result?.kind === 'error' && <Notice tone="danger">{result.text}</Notice>}
          {result?.kind === 'dry' && (
            <Notice>
              Ready: {result.data.fromNumber} would dial {result.data.to} via{' '}
              {result.data.carrierId} with {result.data.variables.length} variable
              {result.data.variables.length === 1 ? '' : 's'}.{' '}
              {result.data.callingWindow
                ? `Calling hours ${result.data.callingWindow.start}–${result.data.callingWindow.end} ${result.data.callingWindow.timezone} are open.`
                : 'This release has no calling-hours window.'}
            </Notice>
          )}
          {result?.kind === 'launched' && (
            <Notice>
              Test call {result.data.callId} was accepted for admission. Follow it on the Calls
              page; acceptance does not mean the carrier dialed.
            </Notice>
          )}
        </div>
      </div>
    </Panel>
  );
}
