'use client';
import type { FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { ModelPriceCard } from '../../lib/types/price-catalog';
import { formatDateTime } from '../../lib/format';
import { humanisePrice } from '../../lib/derive/costs';
import { SectionCard } from '../ui/section-card';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { StatusBadgeV2 } from '../ui/status-badge';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { useListResource } from './use-list-resource';
import { useDrawerForm } from './use-drawer-form';
import { PriceCardForm } from './price-card-form';

/**
 * Immutable price card versions. Relogic of OPS-13/14: the "Add immutable card version" form
 * moves into a drawer behind an action button, and the list is a DataTableV2 instead of a raw
 * `<table>` with provenance prose spilling across the row.
 */
export function PriceCardPanel({ role }: { role: SessionIdentity['role'] }) {
  const {
    data: cards,
    error: loadError,
    reload: load,
  } = useListResource<ModelPriceCard>('/cost/price-cards?limit=100');
  const drawer = useDrawerForm(load);
  const save = (event: FormEvent<HTMLFormElement>) =>
    drawer.submit(
      event,
      (values) =>
        apiRequest('/cost/price-cards', {
          method: 'POST',
          body: JSON.stringify({
            id: values.get('id'),
            version: values.get('version'),
            provider: values.get('provider'),
            unit: values.get('unit'),
            currency: values.get('currency'),
            minorUnitsPerBlock: values.get('minorUnitsPerBlock'),
            blockQuantity: values.get('blockQuantity'),
            effectiveAt: new Date(String(values.get('effectiveAt'))).toISOString(),
            provenance: values.get('provenance'),
            ...(String(values.get('model') ?? '').trim()
              ? { model: String(values.get('model')).trim() }
              : {}),
            ...(values.get('provisional') ? { provisional: true } : {}),
          }),
        }).then(() => undefined),
      'Price card could not be stored.',
    );

  const columns: ColumnV2<ModelPriceCard>[] = [
    {
      id: 'card',
      header: 'Card',
      cell: (card) => (
        <>
          <strong>{card.id}</strong>
          <br />
          <small className="mono muted">{card.version}</small>
        </>
      ),
      sortValue: (card) => card.id,
    },
    {
      id: 'provider',
      header: 'Provider / unit',
      cell: (card) => `${card.provider} · ${card.unit}`,
    },
    { id: 'model', header: 'Model', cell: (card) => card.model ?? 'Any model' },
    {
      id: 'price',
      header: 'Price',
      cell: (card) => (
        <>
          <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {humanisePrice(card)}
          </span>
          {card.provisional && (
            <>
              {' '}
              <StatusBadgeV2 tone="warn" label="Provisional" size="sm" />
            </>
          )}
        </>
      ),
      align: 'end',
    },
    {
      id: 'effective',
      header: 'Effective',
      cell: (card) => formatDateTime(card.effectiveAt),
      sortValue: (card) => card.effectiveAt,
    },
    {
      id: 'provenance',
      header: 'Provenance',
      cell: (card) => (
        <CodeBlock code={card.provenance} language="text" collapsedLabel="Show provenance" />
      ),
      priority: 'low',
    },
  ];

  return (
    <SectionCard
      title="Immutable price cards"
      description="Native provider units priced against immutable card IDs and versions. Existing versions cannot be overwritten with different economics."
      padding="flush"
      actions={
        role === 'admin' ? (
          <Button variant="primary" type="button" onClick={() => drawer.setOpen(true)}>
            Add card
          </Button>
        ) : undefined
      }
    >
      <DataTableV2
        // See price-catalog-panel.tsx: remounts across the loading → loaded boundary to avoid
        // DataTableV2's hook-count mismatch (foundation request in the build report).
        key={cards === null ? 'loading' : 'loaded'}
        label="Immutable price cards"
        rows={cards ?? []}
        loading={cards === null}
        error={loadError}
        onRetry={load}
        columns={columns}
        rowKey={(card) => `${card.id}:${card.version}`}
        empty="Provider usage cannot be priced until an admin records an immutable card version."
      />
      {role === 'admin' && (
        <Drawer
          open={drawer.open}
          title="Add immutable card version"
          onClose={() => drawer.setOpen(false)}
        >
          <PriceCardForm busy={drawer.busy} error={drawer.error} onSubmit={save} />
        </Drawer>
      )}
    </SectionCard>
  );
}
