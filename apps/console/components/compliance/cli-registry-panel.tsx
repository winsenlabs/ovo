'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { FormField } from '../ui/form-field';
import { InlineAlert } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { formatDate } from '../../lib/format';
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

  const numberColumns: ColumnV2<CliNumber>[] = [
    {
      id: 'phoneNumber',
      header: 'Number',
      cell: (row) => <span className="mono">{row.phoneNumber}</span>,
    },
    { id: 'series', header: 'Series', cell: (row) => SERIES_LABEL[row.series] },
    { id: 'categories', header: 'Categories', cell: (row) => row.categories.join(', ') },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusBadgeV2 value={row.status} />,
    },
  ];
  const declarationColumns: ColumnV2<A2pDeclaration>[] = [
    {
      id: 'range',
      header: 'Range',
      cell: (row) => (
        <span className="mono">
          {row.rangeStart}–{row.rangeEnd}
        </span>
      ),
    },
    { id: 'oap', header: 'Telco and reference', cell: (row) => `${row.oap} · ${row.reference}` },
    {
      id: 'effective',
      header: 'Effective',
      cell: (row) => (row.withdrawnAt ? 'Withdrawn' : `From ${formatDate(row.effectiveFrom)}`),
    },
  ];

  return (
    <div className="stack">
      {error && <InlineAlert tone="danger">{error}</InlineAlert>}
      <h3>Caller numbers</h3>
      <DataTableV2
        key={numbers.length === 0 ? 'empty' : 'data'}
        label="Caller numbers"
        rows={numbers}
        columns={numberColumns}
        rowKey={(row) => row.phoneNumber}
        empty={
          <EmptyStateV2 title="No caller numbers registered">
            Every +91 call is refused until its caller number is registered here.
          </EmptyStateV2>
        }
      />
      <form className="form-grid nested-card" onSubmit={(event) => void submit(event, saveNumber)}>
        <fieldset disabled={!canEdit} className="form-grid">
          <FormField id="cli-number" label="Caller number">
            {(control) => (
              <input {...control} name="phoneNumber" type="tel" placeholder="+911600…" required />
            )}
          </FormField>
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
          <FormField
            id="cli-status"
            label="Status"
            help="Flagged or suspended numbers are never dialed and pause their campaigns."
          >
            {(control) => (
              <select {...control} name="status" defaultValue="active">
                {['active', 'flagged', 'suspended', 'retired'].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            )}
          </FormField>
          <FormField id="cli-oap" label="Telco (OAP)">
            {(control) => <input {...control} name="oap" />}
          </FormField>
          <button className="button align-start" style={{ alignSelf: 'start' }}>
            Save caller number
          </button>
        </fieldset>
      </form>
      <h3>A2P declarations</h3>
      <DataTableV2
        key={declarations.length === 0 ? 'empty' : 'data'}
        label="A2P declarations"
        rows={declarations}
        columns={declarationColumns}
        rowKey={(row) => row.id}
        empty="No A2P declarations on file"
      />
      <form className="form-grid nested-card" onSubmit={(event) => void submit(event, declare)}>
        <fieldset disabled={!canEdit} className="form-grid">
          <FormField id="a2p-start" label="First number">
            {(control) => <input {...control} name="rangeStart" type="tel" required />}
          </FormField>
          <FormField id="a2p-end" label="Last number">
            {(control) => <input {...control} name="rangeEnd" type="tel" required />}
          </FormField>
          <FormField id="a2p-oap" label="Telco (OAP)">
            {(control) => <input {...control} name="oap" required />}
          </FormField>
          <FormField id="a2p-ref" label="Declaration reference">
            {(control) => <input {...control} name="reference" required />}
          </FormField>
          <FormField id="a2p-declared" label="Declared on">
            {(control) => <input {...control} name="declaredAt" type="date" required />}
          </FormField>
          <FormField id="a2p-effective" label="Effective from">
            {(control) => <input {...control} name="effectiveFrom" type="date" required />}
          </FormField>
          <button className="button align-start" style={{ alignSelf: 'start' }}>
            Record declaration
          </button>
        </fieldset>
      </form>
    </div>
  );
}
