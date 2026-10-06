'use client';
import { useCallback, useEffect, useState } from 'react';
import { apiRequest, items, type SessionIdentity } from '../../lib/api';
import type { PriceCatalogItem } from '../../lib/types/price-catalog';
import { EmptyState, Panel, PanelHeader, ResponsiveTable, StatusBadge } from '../primitives';

const STATUS: Record<PriceCatalogItem['status'], { label: string; tone: 'good' | 'warning' }> = {
  imported: { label: 'Imported', tone: 'good' },
  not_imported: { label: 'Not imported', tone: 'warning' },
  update_available: { label: 'Update available', tone: 'warning' },
};

/**
 * OPS-14: the dated vendor price catalog. Each entry is a public list price with its source and
 * retrieval date; importing stores it as an immutable price card, so nobody types meter prices.
 */
export function PriceCatalogPanel({
  role,
  onImported,
}: {
  role: SessionIdentity['role'];
  onImported?: () => void;
}) {
  const [catalog, setCatalog] = useState<PriceCatalogItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const load = useCallback(async () => {
    try {
      setCatalog(items<PriceCatalogItem>((await apiRequest<unknown>('/cost/price-catalog')).data));
      setError(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Price catalog could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  async function importSelected() {
    setBusy(true);
    setError(undefined);
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
      await load();
      onImported?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Price cards could not be imported.');
    } finally {
      setBusy(false);
    }
  }
  const pending = catalog.filter((entry) => entry.status !== 'imported').length;
  return (
    <Panel labelledBy="price-catalog-title">
      <PanelHeader
        id="price-catalog-title"
        title="Vendor price catalog"
        badge={
          <StatusBadge tone={pending ? 'warning' : 'good'}>
            {pending ? `${pending} not imported` : 'All imported'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <p className="muted">
          Public list prices with their source and the date they were read. Importing one stores it
          as an immutable price card. Prices in USD also need an FX version. Check the sources
          monthly: a vendor price change ships as a new catalog version, shown here as an update.
        </p>
        {error && (
          <div className="field-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="muted" role="status">
            {notice}
          </div>
        )}
        {catalog.length === 0 ? (
          <EmptyState title="No catalog entries">The price catalog is unavailable.</EmptyState>
        ) : (
          <ResponsiveTable label="Vendor price catalog">
            <thead>
              <tr>
                {role === 'admin' && <th>Import</th>}
                <th>Card</th>
                <th>Meters</th>
                <th>Model</th>
                <th>Price</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((entry) => (
                <tr key={`${entry.card.id}:${entry.card.version}`}>
                  {role === 'admin' && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Import ${entry.card.id}`}
                        checked={selected.has(entry.card.id)}
                        disabled={entry.status === 'imported'}
                        onChange={() => toggle(entry.card.id)}
                      />
                    </td>
                  )}
                  <td>
                    <strong>{entry.card.id}</strong>
                    <small>{entry.card.version}</small>
                  </td>
                  <td>{entry.meterKeys.join(', ')}</td>
                  <td>{entry.card.model ?? 'Any model'}</td>
                  <td>
                    {entry.card.minorUnitsPerBlock} {entry.card.currency} minor /{' '}
                    {entry.card.blockQuantity} {entry.card.unit}
                    {entry.card.provisional && (
                      <StatusBadge tone="warning">Provisional</StatusBadge>
                    )}
                  </td>
                  <td>
                    <a href={entry.source.url} target="_blank" rel="noreferrer">
                      {entry.source.quote}
                    </a>
                    <small>Retrieved {entry.source.retrievedAt}</small>
                    {entry.source.note && <small>{entry.source.note}</small>}
                  </td>
                  <td>
                    <StatusBadge tone={STATUS[entry.status].tone}>
                      {STATUS[entry.status].label}
                    </StatusBadge>
                    {entry.storedVersion && <small>Stored: {entry.storedVersion}</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
        {role === 'admin' && (
          <button
            className="button primary align-start"
            type="button"
            disabled={busy || selected.size === 0}
            onClick={() => void importSelected()}
          >
            {busy
              ? 'Importing…'
              : selected.size
                ? `Import ${selected.size} selected`
                : 'Import selected'}
          </button>
        )}
      </div>
    </Panel>
  );
}
