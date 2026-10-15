'use client';
import { useState } from 'react';
import type { SessionIdentity } from '../../lib/api';
import { PageHeader } from '../ui/layout';
import { Tabs, tabsFrom } from '../ui/tabs';
import { useTabState } from './use-tab-state';
import { CostOverviewPanel } from './cost-overview-panel';
import { PriceCatalogPanel } from './price-catalog-panel';
import { PriceCardPanel } from './price-card-panel';
import { FxVersionPanel } from './fx-version-panel';
import { ReconciliationPanel } from './reconciliation-panel';
import { ScenarioPanel } from './scenario-panel';

const TABS = tabsFrom({
  overview: 'Overview',
  catalog: 'Price catalog',
  cards: 'Price cards',
  fx: 'FX',
  reconciliation: 'Reconciliation',
  scenario: 'Scenario',
});
type TabId = (typeof TABS)[number]['id'];

/**
 * Costs & budgets: header → KPI/meter overview → tabbed detail, instead of seven stacked forms
 * with the live budget state at the very bottom of a 10,500px page (brief defect #18).
 */
export function CostView({ role }: { role: SessionIdentity['role'] }) {
  const [tab, setTab] = useTabState<TabId>('overview');
  const [cardsRevision, setCardsRevision] = useState(0);
  return (
    <div className="ds-stack">
      <PageHeader
        eyebrow="Insights"
        title="Costs & budgets"
        description="Exact paise-based budgets, pricing and reconciliation. Missing provider usage is never treated as free."
      />
      <Tabs items={TABS} current={tab} onSelect={setTab} panelId="cost-tab-panel" />
      <div id="cost-tab-panel" role="tabpanel" className="ds-stack">
        {tab === 'overview' && <CostOverviewPanel role={role} />}
        {tab === 'catalog' && (
          <PriceCatalogPanel
            role={role}
            onImported={() => setCardsRevision((value) => value + 1)}
          />
        )}
        {tab === 'cards' && <PriceCardPanel key={cardsRevision} role={role} />}
        {tab === 'fx' && <FxVersionPanel role={role} />}
        {tab === 'reconciliation' && <ReconciliationPanel role={role} />}
        {tab === 'scenario' && <ScenarioPanel />}
      </div>
    </div>
  );
}
