'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, ApiError, items, type SessionIdentity } from '../../lib/api';
import type { BudgetSnapshot } from '../../lib/operator-api';
import { useFormAction } from '../forms/use-form-action';
import {
  EmptyState,
  Field,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

const formatInr = (paise: string) => {
  const value = Number(paise);
  return Number.isSafeInteger(value)
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(value / 100)
    : `${paise} paise`;
};

export function BudgetPanel({ role }: { role: SessionIdentity['role'] }) {
  const formAction = useFormAction();
  const [budgets, setBudgets] = useState<BudgetSnapshot[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (role !== 'admin') return;
    try {
      setBudgets(
        items<BudgetSnapshot>((await apiRequest<unknown>('/cost/budgets?limit=100')).data),
      );
      setError(undefined);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 503
          ? 'The cost ledger is not configured.'
          : failure instanceof Error
            ? failure.message
            : 'Budgets unavailable.',
      );
    }
  }, [role]);
  useEffect(() => {
    void load();
  }, [load]);
  async function save(event: FormEvent<HTMLFormElement>) {
    setBusy(true);
    setError(undefined);
    try {
      await formAction(event, async (values) => {
        await apiRequest('/cost/budgets', {
          method: 'POST',
          body: JSON.stringify({ id: values.get('id'), limitPaise: values.get('limitPaise'), admissionOverspendPaise: values.get('admissionOverspendPaise') }),
        });
        await load();
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Budget could not be saved.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel labelledBy="budgets-title">
      <PanelHeader
        id="budgets-title"
        title="Admission budgets"
        badge={
          <StatusBadge tone={budgets.some((budget) => budget.overLimit) ? 'danger' : 'soft'}>
            {role === 'admin' ? `${budgets.length} budgets` : 'Admin only'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        {role !== 'admin' ? (
          <div className="muted">
            Budget balances and policy changes are restricted to administrators.
          </div>
        ) : (
          <form className="form-grid nested-card" onSubmit={save}>
            <Field label="Budget ID" htmlFor="budget-id">
              <input id="budget-id" name="id" required maxLength={200} />
            </Field>
            <Field label="Hard limit (paise)" htmlFor="budget-limit">
              <input
                id="budget-limit"
                name="limitPaise"
                required
                inputMode="numeric"
                pattern="\d+"
              />
            </Field>
            <Field
              label="Admission overspend allowance (paise)"
              htmlFor="budget-overspend"
              help="Explicit bounded allowance used only by admission policy."
            >
              <input
                id="budget-overspend"
                name="admissionOverspendPaise"
                required
                inputMode="numeric"
                pattern="\d+"
                defaultValue="0"
              />
            </Field>
            <button className="button primary align-start" disabled={busy}>
              {busy ? 'Saving…' : 'Create or verify budget'}
            </button>
          </form>
        )}
        {error ? (
          <div className="field-error" role="alert">{error}</div>
        ) : role === 'admin' && !budgets.length ? (
          <EmptyState title="No budgets configured">
            Create a persisted budget to gate new work by exact reserved and spent paise.
          </EmptyState>
        ) : role === 'admin' ? (
          <ResponsiveTable label="Persisted admission budgets">
            <thead>
              <tr>
                <th>Budget</th>
                <th>Limit</th>
                <th>Spent</th>
                <th>Reserved</th>
                <th>Available for admission</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {budgets.map((budget) => (
                <tr key={budget.id}>
                  <td className="mono">{budget.id}</td>
                  <td>{formatInr(budget.limitPaise)}</td>
                  <td>{formatInr(budget.spentPaise)}</td>
                  <td>{formatInr(budget.reservedPaise)}</td>
                  <td>{formatInr(budget.availableForAdmissionPaise)}</td>
                  <td>
                    <StatusBadge tone={budget.overLimit ? 'danger' : 'good'}>
                      {budget.overLimit ? 'Over limit' : 'Within limit'}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        ) : null}
      </div>
    </Panel>
  );
}
