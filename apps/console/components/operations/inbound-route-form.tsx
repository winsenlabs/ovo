'use client';
import { useState, type FormEvent } from 'react';
import type { Release, ProviderBinding, SessionIdentity } from '../../lib/api';
import type { InboundRouteRecord } from '../../lib/operator-api';
import type { PluginOption } from '../plugins/types';
import { FormField } from '../ui/form-field';
import { formatDateTime } from '../../lib/format';

/** One `{key, value}` row in the variables editor; a trailing blank row is always kept so adding
 * a new variable never needs an extra "+" click to reveal an input. */
export type VariableRow = { key: string; value: string };

export function variableRowsFromRecord(variables: Record<string, string>): VariableRow[] {
  const rows = Object.entries(variables).map(([key, value]) => ({ key, value }));
  return [...rows, { key: '', value: '' }];
}

export function variablesFromRows(rows: readonly VariableRow[]): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]),
  );
}

/** Variables as key/value rows (brief: "not JSON") — the API still receives a flat string map. */
function VariablesEditor({
  rows,
  setRows,
  disabled,
}: {
  rows: readonly VariableRow[];
  setRows: (rows: VariableRow[]) => void;
  disabled?: boolean;
}) {
  const update = (index: number, patch: Partial<VariableRow>) => {
    const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
    // Keep exactly one trailing blank row so there is always a place to type the next variable.
    const last = next[next.length - 1];
    setRows(last && (last.key || last.value) ? [...next, { key: '', value: '' }] : next);
  };
  const remove = (index: number) => setRows(rows.filter((_, i) => i !== index));
  return (
    <fieldset className="ds-kv-editor" disabled={disabled}>
      <legend>Release variables</legend>
      <p className="muted">
        Snapshotted when the signed inbound request is admitted; the API validates required
        variables against the selected release.
      </p>
      {rows.map((row, index) => (
        <div className="ds-kv-editor-row" key={index}>
          <input
            aria-label={`Variable ${index + 1} name`}
            placeholder="Variable name"
            value={row.key}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <input
            aria-label={`Variable ${index + 1} value`}
            placeholder="Value"
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          {(row.key || row.value) && (
            <button
              type="button"
              className="ds-icon-button"
              aria-label={`Remove variable ${index + 1}`}
              onClick={() => remove(index)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </fieldset>
  );
}

export function InboundRouteForm({
  editing,
  phoneNumber,
  setPhoneNumber,
  releaseId,
  setReleaseId,
  carrierPluginId,
  setCarrierPluginId,
  carrierBindingId,
  setCarrierBindingId,
  variableRows,
  setVariableRows,
  enabled,
  setEnabled,
  releases,
  releaseReady,
  carriers,
  bindings,
  role,
  busy,
  onSave,
  onCancel,
}: {
  editing?: InboundRouteRecord;
  phoneNumber: string;
  setPhoneNumber: (value: string) => void;
  releaseId: string;
  setReleaseId: (value: string) => void;
  carrierPluginId: string;
  setCarrierPluginId: (value: string) => void;
  carrierBindingId: string;
  setCarrierBindingId: (value: string) => void;
  variableRows: VariableRow[];
  setVariableRows: (rows: VariableRow[]) => void;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  releases: Array<Release & { agentName: string }>;
  releaseReady: boolean;
  carriers: PluginOption[];
  bindings: ProviderBinding[];
  role: SessionIdentity['role'];
  busy: boolean;
  onSave: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onCancel: () => void;
}) {
  const readOnly = role !== 'admin';
  return (
    <form className="stack" onSubmit={onSave}>
      <FormField id="inbound-route-number" label="Inbound phone number">
        {(control) => (
          <input
            {...control}
            type="tel"
            placeholder="+91…"
            pattern="\+[1-9][0-9]{7,14}"
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
            disabled={readOnly || Boolean(editing)}
            required
          />
        )}
      </FormField>
      <FormField id="inbound-route-release" label="Immutable release">
        {(control) => (
          <select
            {...control}
            value={releaseId}
            onChange={(event) => setReleaseId(event.target.value)}
            disabled={readOnly}
            required
          >
            <option value="">Select immutable release</option>
            {releases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.agentName} · {release.id} · {formatDateTime(release.createdAt)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id="inbound-route-carrier" label="Carrier plugin">
        {(control) => (
          <select
            {...control}
            value={carrierPluginId}
            disabled={readOnly}
            onChange={(event) => {
              setCarrierPluginId(event.target.value);
              setCarrierBindingId('');
            }}
          >
            <option value="">Environment carrier</option>
            {carriers.map((carrier) => (
              <option key={carrier.id} value={carrier.id}>
                {carrier.ui?.label ?? carrier.id}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id="inbound-route-carrier-binding" label="Carrier binding">
        {(control) => (
          <select
            {...control}
            value={carrierBindingId}
            disabled={readOnly}
            onChange={(event) => setCarrierBindingId(event.target.value)}
          >
            <option value="">Environment binding</option>
            {bindings
              .filter((binding) => binding.pluginId === carrierPluginId)
              .map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {binding.label}
                </option>
              ))}
          </select>
        )}
      </FormField>
      <VariablesEditor rows={variableRows} setRows={setVariableRows} disabled={readOnly} />
      {/* A native checkbox, not the `Switch` primitive: its accessible role must stay "checkbox"
          (the API this route config really is), simply at native size — the fix for the brief's
          "giant centred checkbox" defect, not a role change. */}
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          disabled={readOnly}
        />
        <span>Accept inbound admission on this route</span>
      </label>
      <div className="button-row">
        <button className="button primary" disabled={readOnly || busy || !releaseReady}>
          {busy ? 'Saving…' : editing ? 'Save route version' : 'Create route'}
        </button>
        <button className="button" type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
