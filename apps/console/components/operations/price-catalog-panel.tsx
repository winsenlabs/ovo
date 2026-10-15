'use client';
import { useState } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { PriceCatalogItem } from '../../lib/types/price-catalog';
import { formatDate } from '../../lib/format';
import { CATALOG_STATUS_LABEL, CATALOG_STATUS_TONE, humanisePrice } from '../../lib/derive/costs';
import { humaniseEnum } from '../../lib/status';
import { StatusBadgeV2 } from '../ui/status-badge';
import { SectionCard } from '../ui/section-card';
import { DataTableV2, type ColumnV2 } from '../ui/data-table-v2';
import { InlineAlert } from '../ui/feedback-v2';
import { Button } from '../ui/button';
import { usePriceCatalog } from './use-price-catalog';

/**
 * The dated vendor price catalog: what admins pick cards to import from. Relogic of OPS-14 — the
 * catalog is a DataTableV2 with humanised card names and prices instead of raw minor-unit text,
 * and a bulk "Import N selected" action bar instead of a lone button at the page foot.
 */
export function PriceCatalogPanel({
  role,
  onImported,
}: {
  role: SessionIdentity['role'];
  onImported?: () => void;
}) {
  const { catalog, error: loadError, reload } = usePriceCatalog();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function importSelected() {
    setBusy(true);
    setImportError(undefined);
    setNotice(undefined);
    try {
      const { data } = await apiRequest<{ items: unknown[] }>('/cost/price-catalog/import', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selected] }),
      });
      setNotice(
        `Imported ${data.items.length} price ${data.items.length === 1 ? 'card' : 'cards'}.`,
      );
      setSelected(new Set());
      await reload();
      onImported?.();
    } catch (failure) {
      setImportError(
        failure instanceof Error ? failure.message : 'Price cards could not be imported.',
      );
    } finally {
      setBusy(false);
    }
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const columns: ColumnV2<PriceCatalogItem>[] = [
    ...(role === 'admin'
      ? [
          {
            id: 'select',
            header: 'Import',
            cell: (entry: PriceCatalogItem) => (
              <input
                type="checkbox"
                aria-label={`Import ${entry.card.id}`}
                checked={selected.has(entry.card.id)}
                disabled={entry.status === 'imported'}
                onChange={() => toggle(entry.card.id)}
              />
            ),
          } satisfies ColumnV2<PriceCatalogItem>,
        ]
      : []),
    {
      id: 'card',
      header: 'Card',
      cell: (entry) => (
        <>
          <strong>
            {entry.card.provider} · {entry.card.model ?? 'Any model'}
          </strong>
          <br />
          <small className="mono muted">
            {entry.card.id} · {entry.card.version}
          </small>
        </>
      ),
      sortValue: (entry) => entry.card.id,
    },
    {
      id: 'meters',
      header: 'Meters',
      cell: (entry) => (
        <span className="ds-choice-chips">
          {entry.meterKeys.map((key) => (
            <span key={key} className="ds-chip">
              {humaniseEnum(key.split('.').pop())}
            </span>
          ))}
        </span>
      ),
      priority: 'low',
    },
    {
      id: 'price',
      header: 'Price',
      cell: (entry) => (
        <span className="mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {humanisePrice(entry.card)}
          {entry.card.provisional && (
            <>
              {' '}
              <StatusBadgeV2 tone="warn" label="Provisional" size="sm" />
            </>
          )}
        </span>
      ),
      align: 'end',
    },
    {
      id: 'source',
      header: 'Source',
      cell: (entry) => (
        <>
          <a href={entry.source.url} target="_blank" rel="noreferrer">
            {entry.source.quote}
          </a>
          <br />
          <small className="muted">Retrieved {formatDate(entry.source.retrievedAt)}</small>
        </>
      ),
      priority: 'low',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (entry) => (
        <StatusBadgeV2
          tone={CATALOG_STATUS_TONE[entry.status]}
          label={CATALOG_STATUS_LABEL[entry.status]}
        />
      ),
    },
  ];

  return (
    <SectionCard
      title="Vendor price catalog"
      description="Public list prices with their source and retrieval date. Importing stores one as an immutable price card. Check sources monthly: a vendor change ships as a new catalog version, shown here as an update."
      padding="flush"
      actions={
        role === 'admin' && selected.size > 0 ? (
          <Button
            variant="primary"
            type="button"
            disabled={busy}
            onClick={() => void importSelected()}
          >
            {busy ? 'Importing…' : `Import ${selected.size} selected`}
          </Button>
        ) : undefined
      }
    >
      {loadError && <InlineAlert onRetry={reload}>{loadError}</InlineAlert>}
      {importError && <InlineAlert>{importError}</InlineAlert>}
      {notice && <InlineAlert tone="info">{notice}</InlineAlert>}
      <DataTableV2
        // Remounts across the loading/empty → loaded boundary: DataTableV2 calls `useRef`/
        // `useEffect` only past its early loading/empty returns, so the same mounted instance
        // going from one branch to the other throws "Rendered more hooks than during the
        // previous render" (see the foundation request in the build report).
        key={catalog === null ? 'loading' : 'loaded'}
        label="Vendor price catalog"
        rows={catalog ?? []}
        loading={catalog === null}
        columns={columns}
        rowKey={(entry) => `${entry.card.id}:${entry.card.version}`}
        empty="The price catalog is unavailable."
      />
    </SectionCard>
  );
}
