'use client';
import { useState } from 'react';
import { CodeBlock } from '../../../components/ui/code-block';
import { DataTableV2 } from '../../../components/ui/data-table-v2';
import { Duration, PhoneNumber, RelativeTime } from '../../../components/ui/display';
import { KpiCard, KpiStrip } from '../../../components/ui/kpi';
import { PaginationV2 } from '../../../components/ui/pagination-v2';
import { IdChip, KeyValueGrid, SectionCard } from '../../../components/ui/section-card';
import { StatusBadgeV2 } from '../../../components/ui/status-badge';
import { Tabs } from '../../../components/ui/tabs';
import { DateRangePicker, FilterBar, type CustomRange } from '../../../components/ui/toolbar';
import { Percent } from '../../../components/ui/display';

const DEMO_UPDATED_AT = '2026-10-15T01:54:00.000Z';
const DEMO_ROWS = [
  { id: 'call_1', agent: 'EMI reminder', status: 'completed', durationMs: 42000 },
  { id: 'call_2', agent: 'KYC refresh', status: 'failed', durationMs: 11200 },
  { id: 'call_3', agent: 'EMI reminder', status: 'in_progress', durationMs: 8000 },
];

/** Tokens, KPI strip, tabs, filters and the data table. Split out to satisfy the module-size gate. */
export function TokensAndDataSections() {
  const [tab, setTab] = useState('overview');
  const [range, setRange] = useState<'1h' | '24h' | '7d' | '30d' | 'custom'>('24h');
  const [customRange, setCustomRange] = useState<CustomRange>({ from: '', to: '' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(['call_1']));

  return (
    <>
      <SectionCard title="Status tones">
        <div className="ds-kpi-strip">
          {(['ok', 'info', 'warn', 'danger', 'neutral'] as const).map((tone) => (
            <StatusBadgeV2 key={tone} tone={tone} label={tone} />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="KPI strip">
        <KpiStrip>
          <KpiCard
            label="Calls (24h)"
            value="1,284"
            delta={{ value: 6 }}
            sparkline={[3, 5, 4, 7, 9, 6, 8]}
          />
          <KpiCard
            label="Completion rate"
            value={<Percent value={0.943} />}
            delta={{ value: -2, tone: 'danger' }}
          />
          <KpiCard label="Median duration" value={<Duration ms={48200} />} />
          <KpiCard label="Unknown example" value={null} footnote="Not configured" />
          <KpiCard label="Loading example" value="" loading />
        </KpiStrip>
      </SectionCard>

      <SectionCard
        title="Tabs"
        tabs={
          <Tabs
            items={[
              { id: 'overview', label: 'Overview' },
              { id: 'data', label: 'Data' },
            ]}
            current={tab}
            onSelect={setTab}
          />
        }
      >
        {tab === 'overview' ? (
          <p className="muted">Overview panel content.</p>
        ) : (
          <p className="muted">Data panel content.</p>
        )}
      </SectionCard>

      <SectionCard title="Filters">
        <FilterBar
          search=""
          onSearch={() => undefined}
          filters={
            <DateRangePicker
              value={range}
              onChange={setRange}
              custom={customRange}
              onCustomChange={setCustomRange}
            />
          }
          chips={[{ id: 'status', label: 'Status: Failed' }]}
          onClearChip={() => undefined}
          onClearAll={() => undefined}
        />
      </SectionCard>

      <SectionCard title="Data table" padding="flush">
        <DataTableV2
          label="Demo calls"
          rows={DEMO_ROWS}
          rowKey={(row) => row.id}
          rowHref={(row) => `#${row.id}`}
          selected={selected}
          onSelectChange={setSelected}
          columns={[
            {
              id: 'agent',
              header: 'Agent',
              cell: (row) => row.agent,
              sortValue: (row) => row.agent,
            },
            { id: 'status', header: 'Status', cell: (row) => <StatusBadgeV2 value={row.status} /> },
            {
              id: 'duration',
              header: 'Duration',
              align: 'end',
              cell: (row) => <Duration ms={row.durationMs} />,
              sortValue: (row) => row.durationMs,
            },
          ]}
        />
        <div className="ds-card-footer">
          <PaginationV2
            from={1}
            to={3}
            total={3}
            hasPrevious={false}
            hasNext={false}
            onPrevious={() => undefined}
            onNext={() => undefined}
          />
        </div>
      </SectionCard>

      <SectionCard title="Key-value + id chip + copy">
        <KeyValueGrid
          items={[
            { label: 'Agent', value: 'EMI reminder' },
            { label: 'Release', value: <IdChip id="rel_8f3a2b9c1d0e" short="rel_8f3a2b…d0e" /> },
            { label: 'Phone', value: <PhoneNumber value="+919820000000" /> },
            { label: 'Updated', value: <RelativeTime value={DEMO_UPDATED_AT} /> },
            { label: 'Unknown field', value: null },
          ]}
        />
      </SectionCard>

      <SectionCard title="Code block">
        <CodeBlock code={() => JSON.stringify({ hello: 'world', nested: { ok: true } }, null, 2)} />
      </SectionCard>
    </>
  );
}
