'use client';
import type { AgentConfig } from '../../lib/api';
import {
  EmptyState,
  Field,
  Notice,
  Panel,
  PanelHeader,
  ResponsiveTable,
  StatusBadge,
} from '../primitives';

type CostPolicy = NonNullable<AgentConfig['costPolicy']>;
type PriceReference = CostPolicy['priceCards'][string];
const emptyPolicy = (): CostPolicy => ({
  budgetId: '',
  reservationPaise: '1',
  maxCallSeconds: 300,
  priceCards: {},
});

export function CostPolicyEditor({
  config,
  update,
}: {
  config: AgentConfig;
  update: (next: AgentConfig) => void;
}) {
  const policy = config.costPolicy;
  const setPolicy = (next: CostPolicy | undefined) => update({ ...config, costPolicy: next });
  const rows = Object.entries(policy?.priceCards ?? {});
  const patchReference = (key: string, patch: Partial<PriceReference>) =>
    policy &&
    setPolicy({
      ...policy,
      priceCards: { ...policy.priceCards, [key]: { ...policy.priceCards[key]!, ...patch } },
    });
  return (
    <Panel labelledBy="cost-policy-title">
      <PanelHeader
        id="cost-policy-title"
        title="Cost admission policy"
        badge={
          <StatusBadge tone={policy ? 'soft' : 'warning'}>
            {policy ? 'Configured' : 'Not configured'}
          </StatusBadge>
        }
      />
      <div className="panel-body stack">
        <p className="muted">
          A live worker reserves this exact paise amount before work begins, then settles native
          provider usage against immutable price and FX versions.
        </p>
        {!policy ? (
          <EmptyState title="No admission cost policy">
            Calls are not budget-gated by this agent configuration.
            <button className="button" type="button" onClick={() => setPolicy(emptyPolicy())}>
              Configure cost policy
            </button>
          </EmptyState>
        ) : (
          <>
            <div className="form-grid">
              <Field label="Budget ID" htmlFor="agent-budget-id">
                <input
                  id="agent-budget-id"
                  value={policy.budgetId}
                  onChange={(event) => setPolicy({ ...policy, budgetId: event.target.value })}
                />
              </Field>
              <Field label="Reservation amount (paise)" htmlFor="agent-reservation">
                <input
                  id="agent-reservation"
                  inputMode="numeric"
                  pattern="[1-9]\d*"
                  value={policy.reservationPaise}
                  onChange={(event) =>
                    setPolicy({ ...policy, reservationPaise: event.target.value })
                  }
                />
              </Field>
              <Field label="Maximum call seconds" htmlFor="agent-max-call">
                <input
                  id="agent-max-call"
                  type="number"
                  min={1}
                  max={14400}
                  value={policy.maxCallSeconds}
                  onChange={(event) =>
                    setPolicy({ ...policy, maxCallSeconds: Number(event.target.value) })
                  }
                />
              </Field>
            </div>
            <Notice tone="warning">
              Each provider usage key needs an immutable price-card version. Non-INR cards also
              require an immutable FX version.
            </Notice>
            <ResponsiveTable label="Agent price card references">
              <thead>
                <tr>
                  <th>Usage key</th>
                  <th>Price card</th>
                  <th>Version</th>
                  <th>FX ID</th>
                  <th>FX version</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([key, reference]) => (
                  <tr key={key}>
                    <td>
                      <input
                        aria-label="Usage key"
                        defaultValue={key}
                        onBlur={(event) => {
                          const nextKey = event.target.value.trim();
                          if (!nextKey || nextKey === key) return;
                          const next = { ...policy.priceCards };
                          delete next[key];
                          next[nextKey] = reference;
                          setPolicy({ ...policy, priceCards: next });
                        }}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${key} price card ID`}
                        value={reference.id}
                        onChange={(event) => patchReference(key, { id: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${key} price card version`}
                        value={reference.version}
                        onChange={(event) => patchReference(key, { version: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${key} FX ID`}
                        value={reference.fxId ?? ''}
                        onChange={(event) =>
                          patchReference(key, { fxId: event.target.value || undefined })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`${key} FX version`}
                        value={reference.fxVersion ?? ''}
                        onChange={(event) =>
                          patchReference(key, { fxVersion: event.target.value || undefined })
                        }
                      />
                    </td>
                    <td>
                      <button
                        className="text-button danger-text"
                        type="button"
                        onClick={() => {
                          const next = { ...policy.priceCards };
                          delete next[key];
                          setPolicy({ ...policy, priceCards: next });
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
            <div className="button-row">
              <button
                className="button"
                type="button"
                onClick={() => {
                  let key = 'provider-usage';
                  for (let index = 2; policy.priceCards[key]; index += 1)
                    key = `provider-usage-${index}`;
                  setPolicy({
                    ...policy,
                    priceCards: { ...policy.priceCards, [key]: { id: '', version: '' } },
                  });
                }}
              >
                Add price card
              </button>
              <button className="button danger" type="button" onClick={() => setPolicy(undefined)}>
                Remove policy
              </button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
