'use client';
import type { SessionIdentity } from '../../lib/api';
import { catalogStatusSlices } from '../../lib/derive/costs';
import { SectionCard } from '../ui/section-card';
import { ChartFrame } from '../charts/chart-frame';
import { Donut } from '../charts/donut';
import { BudgetPanel } from './budget-panel';
import { usePriceCatalog } from './use-price-catalog';

/**
 * Costs overview: the live budget state up top (via `BudgetPanel`), then pricing coverage as a
 * donut instead of a 13-row table the operator has to read line by line.
 */
export function CostOverviewPanel({ role }: { role: SessionIdentity['role'] }) {
  const { catalog, error, reload } = usePriceCatalog();
  const slices = catalog ? catalogStatusSlices(catalog) : [];
  const pending = catalog?.filter((entry) => entry.status !== 'imported').length ?? 0;

  return (
    <div className="ds-stack">
      <BudgetPanel role={role} />
      <SectionCard title="Pricing coverage" description="Vendor price catalog import status.">
        <ChartFrame
          ariaLabel="Price catalog coverage by import status"
          loading={catalog === null}
          error={error}
          onRetry={reload}
          empty={catalog !== null && catalog.length === 0}
          emptyLabel="No catalog entries"
          height={180}
          tableRows={slices.length}
          tableColumns={[
            { header: 'Status', cell: (index) => slices[index]?.label },
            { header: 'Cards', cell: (index) => slices[index]?.value },
          ]}
          renderChart={() => (
            <Donut slices={slices} centerLabel={pending ? `${pending} pending` : 'All imported'} />
          )}
        />
      </SectionCard>
    </div>
  );
}
