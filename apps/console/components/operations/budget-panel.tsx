'use client';
import type { FormEvent } from 'react';
import { apiRequest, type SessionIdentity } from '../../lib/api';
import type { BudgetSnapshot } from '../../lib/operator-api';
import { budgetMeter } from '../../lib/derive/costs';
import { formatMoney } from '../../lib/format';
import { KpiCard, KpiStrip } from '../ui/kpi';
import { SectionCard } from '../ui/section-card';
import { ProgressMeter } from '../charts/meter';
import { EmptyStateV2, ErrorState, Skeleton } from '../ui/feedback-v2';
import { Drawer } from '../ui/drawer';
import { Button } from '../ui/button';
import { useListResource } from './use-list-resource';
import { useDrawerForm } from './use-drawer-form';

/** `.ds-kpi-value` renders as one unbreakable token; at the 2-column 390px breakpoint a full
 * aggregate rupee sum (unlike the small integers "Budgets"/"Over limit" used before) is wider
 * than its column and forces the whole page to scroll horizontally. `overflowWrap: anywhere`
 * lets it break inside the column instead (the four new aggregate KPIs below, verifier medium
 * #18, were the first KpiCards in this strip with values long enough to trigger it). */
function MoneyValue({ paise }: { paise: number }) {
  return <span style={{ overflowWrap: 'anywhere' }}>{formatMoney(paise)}</span>;
}

/**
 * The live financial state, now first: a KPI strip plus one segmented meter per budget (spent /
 * reserved against the hard limit), with the create form moved into a drawer. Previously budgets
 * were the last of seven panels on a 10,500px page (brief defect #18).
 */
export function BudgetPanel({ role }: { role: SessionIdentity['role'] }) {
  const {
    data: budgets,
    error,
    reload,
  } = useListResource<BudgetSnapshot>(
    role === 'admin' ? '/cost/budgets?limit=100' : null,
    'The cost ledger is not configured on this installation.',
  );
  const drawer = useDrawerForm(reload);
  const save = (event: FormEvent<HTMLFormElement>) =>
    drawer.submit(
      event,
      (values) =>
        apiRequest('/cost/budgets', {
          method: 'POST',
          body: JSON.stringify({
            id: values.get('id'),
            limitPaise: values.get('limitPaise'),
            admissionOverspendPaise: values.get('admissionOverspendPaise'),
          }),
        }).then(() => undefined),
      'Budget could not be saved.',
    );

  if (role !== 'admin')
    return (
      <SectionCard title="Admission budgets">
        <EmptyStateV2 variant="unavailable" title="Admin only">
          Budget balances and policy changes are restricted to administrators.
        </EmptyStateV2>
      </SectionCard>
    );

  const overLimit = budgets?.filter((budget) => budget.overLimit).length ?? 0;
  // Aggregate limit/spent/reserved/available across every budget for the KPI strip (the brief
  // asks for all four; only "Budgets" and "Over limit" were there before — verifier medium #18).
  // `availableForAdmissionPaise` is already computed server-side by the ledger, so it's summed
  // as-is rather than re-derived client-side from limit − spent − reserved.
  const totalsPaise = budgets?.reduce(
    (sum, budget) => ({
      limit: sum.limit + Number(budget.limitPaise),
      spent: sum.spent + Number(budget.spentPaise),
      reserved: sum.reserved + Number(budget.reservedPaise),
      available: sum.available + Number(budget.availableForAdmissionPaise),
    }),
    { limit: 0, spent: 0, reserved: 0, available: 0 },
  );
  const createAction = (
    <Button variant="primary" type="button" onClick={() => drawer.setOpen(true)}>
      Create budget
    </Button>
  );

  return (
    <div className="ds-stack">
      <KpiStrip>
        <KpiCard
          label="Budgets"
          value={error ? null : (budgets?.length ?? null)}
          loading={budgets === null && !error}
        />
        <KpiCard
          label="Over limit"
          value={error ? null : overLimit}
          loading={budgets === null && !error}
          delta={
            budgets && !error && overLimit > 0
              ? { value: overLimit, tone: 'danger', label: 'over' }
              : undefined
          }
        />
        <KpiCard
          label="Limit"
          value={error || !totalsPaise ? null : <MoneyValue paise={totalsPaise.limit} />}
          loading={budgets === null && !error}
        />
        <KpiCard
          label="Spent"
          value={error || !totalsPaise ? null : <MoneyValue paise={totalsPaise.spent} />}
          loading={budgets === null && !error}
        />
        <KpiCard
          label="Reserved"
          value={error || !totalsPaise ? null : <MoneyValue paise={totalsPaise.reserved} />}
          loading={budgets === null && !error}
        />
        <KpiCard
          label="Available"
          value={error || !totalsPaise ? null : <MoneyValue paise={totalsPaise.available} />}
          loading={budgets === null && !error}
        />
      </KpiStrip>
      <SectionCard
        title="Admission budgets"
        description="Spent and reserved against each hard limit."
        actions={createAction}
      >
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : budgets === null ? (
          <Skeleton shape="chart" />
        ) : budgets.length === 0 ? (
          <EmptyStateV2 variant="first-run" title="No budgets configured" action={createAction}>
            Create a persisted budget to gate new work by exact reserved and spent paise.
          </EmptyStateV2>
        ) : (
          <div className="ds-stack">
            {budgets.map((budget) => {
              const meter = budgetMeter(budget);
              return (
                <div key={budget.id}>
                  <ProgressMeter
                    label={budget.id}
                    segments={meter.segments}
                    max={meter.max}
                    valueLabel={`${formatMoney(budget.spentPaise)} of ${formatMoney(budget.limitPaise)}${
                      budget.overLimit ? ' · over limit' : ''
                    }`}
                  />
                  {/* The meter's own colour has no on-screen key (verifier medium #7/#18): these
                      badges reuse the same tones as `budgetMeter`'s segments and spell out the
                      exact rupee amount behind each one. */}
                  <div className="ui-cluster" style={{ marginTop: 'var(--space-2)' }}>
                    <span className="ds-badge tone-ok size-sm">
                      Spent {formatMoney(budget.spentPaise)}
                    </span>
                    <span className="ds-badge tone-warn size-sm">
                      Reserved {formatMoney(budget.reservedPaise)}
                    </span>
                    <span className="ds-badge tone-neutral size-sm">
                      Available {formatMoney(budget.availableForAdmissionPaise)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
      <Drawer
        open={drawer.open}
        title="Create or verify budget"
        onClose={() => drawer.setOpen(false)}
      >
        <form className="stack" onSubmit={save}>
          <div className="field">
            <label htmlFor="budget-id">Budget ID</label>
            <input id="budget-id" name="id" required maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="budget-limit">Hard limit (paise)</label>
            <input id="budget-limit" name="limitPaise" required inputMode="numeric" pattern="\d+" />
          </div>
          <div className="field">
            <label htmlFor="budget-overspend">Admission overspend allowance (paise)</label>
            <input
              id="budget-overspend"
              name="admissionOverspendPaise"
              required
              inputMode="numeric"
              pattern="\d+"
              defaultValue="0"
            />
            <small>Explicit bounded allowance used only by admission policy.</small>
          </div>
          {drawer.error && (
            <div className="field-error" role="alert">
              {drawer.error}
            </div>
          )}
          <button className="button primary" disabled={drawer.busy}>
            {drawer.busy ? 'Saving…' : 'Create or verify budget'}
          </button>
        </form>
      </Drawer>
    </div>
  );
}
