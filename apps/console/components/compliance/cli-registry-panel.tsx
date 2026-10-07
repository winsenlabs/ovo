'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';
import { failureText, type A2pDeclaration, type CliNumber } from './compliance-types';

const SERIES_LABEL = {
  '140': '140 · promotional',
  '1600': '1600 · BFSI / Government service',
  '1601': '1601 · sector service',
  other: 'Not a designated series',
};

/**
 * The caller numbers this workspace dials from, their series (derived from the digits, R2-R4),
 * and the A2P declarations filed with the telco (R7).
 */
export function CliRegistryPanel({
  numbers,
  declarations,
  canEdit,
  onChanged,
}: {
  numbers: CliNumber[];
  declarations: A2pDeclaration[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState<string>();
  async function submit(
    event: FormEvent<HTMLFormElement>,
    write: (values: FormData) => Promise<unknown>,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await write(new FormData(form));
      form.reset();
      setError(undefined);
      await onChanged();
    } catch (failure) {
      setError(failureText(failure, 'The registry could not be updated.'));
    }
  }
  const saveNumber = (values: FormData) =>
    apiRequest(
      `/operations/compliance/cli-numbers/${encodeURIComponent(String(values.get('phoneNumber')))}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          categories: values.getAll('categories'),
          status: values.get('status'),
          ...(values.get('oap') ? { oap: values.get('oap') } : {}),
        }),
      },
    );
  const declare = (values: FormData) =>
    apiRequest('/operations/compliance/a2p-declarations', {
      method: 'POST',
      body: JSON.stringify(
        Object.fromEntries(
          ['rangeStart', 'rangeEnd', 'oap', 'reference', 'declaredAt', 'effectiveFrom'].map(
            (key) => [key, values.get(key)],
          ),
        ),
      ),
    });
  return (
    <Panel labelledBy="cli-registry-title">
      <PanelHeader
        id="cli-registry-title"
        title="Caller numbers and A2P declarations"
        badge={<StatusBadge>{numbers.length}</StatusBadge>}
      />
      {error && <Notice tone="danger">{error}</Notice>}
      {!numbers.length ? (
        <div className="panel-body">
          <EmptyState title="No caller numbers registered">
            Every +91 call is refused until its caller number is registered here.
          </EmptyState>
        </div>
      ) : (
        <ResponsiveTable label="Caller numbers">
          <thead>
            <tr>
              <th>Number</th>
              <th>Series</th>
              <th>Categories</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {numbers.map((row) => (
              <tr key={row.phoneNumber}>
                <td className="mono">{row.phoneNumber}</td>
                <td>{SERIES_LABEL[row.series]}</td>
                <td>{row.categories.join(', ')}</td>
                <td>
                  <StatusBadge tone={row.status === 'active' ? 'good' : 'danger'}>
                    {row.status}
                  </StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      )}
      <form className="panel-body form-grid" onSubmit={(event) => void submit(event, saveNumber)}>
        <fieldset disabled={!canEdit} className="form-grid">
          <Field label="Caller number" htmlFor="cli-number">
            <input id="cli-number" name="phoneNumber" type="tel" placeholder="+911600…" required />
          </Field>
          <fieldset className="field">
            <legend>Categories</legend>
            {['service', 'transactional', 'promotional'].map((category) => (
              <label key={category} className="toggle-row">
                <input
                  type="checkbox"
                  name="categories"
                  value={category}
                  defaultChecked={category === 'service'}
                />
                <span>{category}</span>
              </label>
            ))}
          </fieldset>
          <Field
            label="Status"
            htmlFor="cli-status"
            help="Flagged or suspended numbers are never dialed and pause their campaigns."
          >
            <select id="cli-status" name="status" defaultValue="active">
              {['active', 'flagged', 'suspended', 'retired'].map((status) => (
                <option key={status}>{status}</option>
              ))}
            </select>
          </Field>
          <Field label="Telco (OAP)" htmlFor="cli-oap">
            <input id="cli-oap" name="oap" />
          </Field>
          <button className="button align-start">Save caller number</button>
        </fieldset>
      </form>
      <ResponsiveTable label="A2P declarations">
        <thead>
          <tr>
            <th>Range</th>
            <th>Telco and reference</th>
            <th>Effective</th>
          </tr>
        </thead>
        <tbody>
          {declarations.map((row) => (
            <tr key={row.id}>
              <td className="mono">
                {row.rangeStart}–{row.rangeEnd}
              </td>
              <td>
                {row.oap} · {row.reference}
              </td>
              <td>{row.withdrawnAt ? 'Withdrawn' : `From ${row.effectiveFrom}`}</td>
            </tr>
          ))}
        </tbody>
      </ResponsiveTable>
      <form className="panel-body form-grid" onSubmit={(event) => void submit(event, declare)}>
        <fieldset disabled={!canEdit} className="form-grid">
          <Field label="First number" htmlFor="a2p-start">
            <input id="a2p-start" name="rangeStart" type="tel" required />
          </Field>
          <Field label="Last number" htmlFor="a2p-end">
            <input id="a2p-end" name="rangeEnd" type="tel" required />
          </Field>
          <Field label="Telco (OAP)" htmlFor="a2p-oap">
            <input id="a2p-oap" name="oap" required />
          </Field>
          <Field label="Declaration reference" htmlFor="a2p-ref">
            <input id="a2p-ref" name="reference" required />
          </Field>
          <Field label="Declared on" htmlFor="a2p-declared">
            <input id="a2p-declared" name="declaredAt" type="date" required />
          </Field>
          <Field label="Effective from" htmlFor="a2p-effective">
            <input id="a2p-effective" name="effectiveFrom" type="date" required />
          </Field>
          <button className="button align-start">Record declaration</button>
        </fieldset>
      </form>
    </Panel>
  );
}
