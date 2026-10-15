'use client';
import { useState, type FormEvent } from 'react';
import { apiRequest } from '../../lib/api';
import { InlineAlert } from '../ui/feedback-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { EmptyStateV2 } from '../ui/feedback-v2';
import { SectionCard } from '../ui/section-card';
import { formatDate, formatPhoneNumber } from '../../lib/format';
import { failureText, type A2pDeclaration, type CliNumber } from './compliance-types';
import { AddCliNumberDrawer, RecordA2pDeclarationDrawer } from './cli-registry-forms';

const SERIES_LABEL = {
  '140': '140 · promotional',
  '1600': '1600 · BFSI / Government service',
  '1601': '1601 · sector service',
  other: 'Not a designated series',
};

/**
 * The caller numbers this workspace dials from, their series (derived from the digits, R2-R4),
 * and the A2P declarations filed with the telco (R7). Add/record forms open in a drawer so the
 * two tables stay the page, not a stack of always-open forms under them.
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
  const [drawer, setDrawer] = useState<'number' | 'declaration' | null>(null);
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
      setDrawer(null);
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
      cell: (row) => <span className="mono">{formatPhoneNumber(row.phoneNumber)}</span>,
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
          {formatPhoneNumber(row.rangeStart)}–{formatPhoneNumber(row.rangeEnd)}
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
      <SectionCard
        title="Caller numbers"
        padding="flush"
        actions={
          <button
            className="button small primary"
            type="button"
            disabled={!canEdit}
            onClick={() => setDrawer('number')}
          >
            Add number
          </button>
        }
      >
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
      </SectionCard>
      <SectionCard
        title="A2P declarations"
        padding="flush"
        actions={
          <button
            className="button small primary"
            type="button"
            disabled={!canEdit}
            onClick={() => setDrawer('declaration')}
          >
            Record declaration
          </button>
        }
      >
        <DataTableV2
          key={declarations.length === 0 ? 'empty' : 'data'}
          label="A2P declarations"
          rows={declarations}
          columns={declarationColumns}
          rowKey={(row) => row.id}
          empty="No A2P declarations on file"
        />
      </SectionCard>
      <AddCliNumberDrawer
        open={drawer === 'number'}
        canEdit={canEdit}
        onClose={() => setDrawer(null)}
        onSubmit={(event) => void submit(event, saveNumber)}
      />
      <RecordA2pDeclarationDrawer
        open={drawer === 'declaration'}
        canEdit={canEdit}
        onClose={() => setDrawer(null)}
        onSubmit={(event) => void submit(event, declare)}
      />
    </div>
  );
}
