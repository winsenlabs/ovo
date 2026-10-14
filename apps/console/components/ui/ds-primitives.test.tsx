import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { StatusBadgeV2 } from './status-badge';
import { KpiCard } from './kpi';
import { DataTableV2, type ColumnV2 } from './data-table-v2';
import { RadioCardGroup } from './choice-card';
import { Tabs } from './tabs';

afterEach(() => cleanup());

describe('StatusBadgeV2', () => {
  it('tones a running call as info and humanises the label', () => {
    render(<StatusBadgeV2 value="in_progress" />);
    const badge = screen.getByText('In progress');
    expect(badge.closest('.ds-badge')?.className).toContain('tone-info');
  });
  it('tones cancelled as neutral, never the same tone as failed', () => {
    render(<StatusBadgeV2 value="cancelled" />);
    expect(screen.getByText('Cancelled').closest('.ds-badge')?.className).toContain('tone-neutral');
  });
});

describe('KpiCard', () => {
  it('renders the Unknown dash instead of a silent 0 for a null value', () => {
    render(<KpiCard label="Failures" value={null} />);
    const dash = screen.getByText('—');
    expect(dash.getAttribute('title')).toBe('Unknown');
  });
  it('renders a loading skeleton instead of the value when loading', () => {
    render(<KpiCard label="Calls" value="1,284" loading />);
    expect(screen.queryByText('1,284')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });
  it("keeps the value in the link's accessible name instead of overriding it", () => {
    // An `aria-label` on the link used to replace its whole accessible name with
    // "<label>: open detail", dropping the number a screen-reader user came for.
    render(<KpiCard label="Calls (24h)" value="1,284" href="/calls" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toBeNull();
    expect(link.textContent).toContain('1,284');
  });
  it('gives the delta direction real text, not just an aria-hidden glyph', () => {
    render(<KpiCard label="Calls" value="1,284" delta={{ value: 6 }} />);
    expect(screen.getByText('Up')).toBeTruthy();
  });
});

type Row = { id: string; agent: string; durationMs: number };
const COLUMNS: readonly ColumnV2<Row>[] = [
  { id: 'agent', header: 'Agent', cell: (row) => row.agent, sortValue: (row) => row.agent },
  {
    id: 'duration',
    header: 'Duration',
    cell: (row) => row.durationMs,
    sortValue: (row) => row.durationMs,
  },
];
const ROWS: readonly Row[] = [
  { id: 'a', agent: 'Zed', durationMs: 10 },
  { id: 'b', agent: 'Alpha', durationMs: 30 },
];

describe('DataTableV2', () => {
  it('shows the empty state instead of an empty table when there are no rows', () => {
    render(
      <DataTableV2
        label="Calls"
        rows={[]}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        empty="No calls yet"
      />,
    );
    expect(screen.getByText('No calls yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('sorts ascending then descending on repeated header clicks', () => {
    render(<DataTableV2 label="Calls" rows={ROWS} columns={COLUMNS} rowKey={(r) => r.id} />);
    const header = screen.getByRole('button', { name: /Agent/ });
    const bodyText = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0].textContent);
    fireEvent.click(header);
    expect(bodyText()).toEqual(['Alpha', 'Zed']);
    fireEvent.click(header);
    expect(bodyText()).toEqual(['Zed', 'Alpha']);
  });
  it('makes the whole row a link when rowHref is given', () => {
    render(
      <DataTableV2
        label="Calls"
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        rowHref={(r) => `/calls/${r.id}`}
      />,
    );
    const link = screen.getAllByRole('link')[0] as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/calls/a');
  });
  it('lets a selection checkbox be clicked on a row-linked table without navigating', () => {
    // The row-link overlay (`.ds-row-link-anchor::after { inset: 0 }`) used to sit above every
    // control in the row, so `elementFromPoint` resolved a checkbox click to the overlay instead
    // (brief defect #4). Exercising the checkbox's own `onChange` is the DOM-level proxy for
    // that: the overlay's CSS (`z-index: 0` under a real control) is covered by the row-link
    // test below; this test guards the checkbox stays reachable and wired at all.
    const onSelectChange = vi.fn();
    render(
      <DataTableV2
        label="Calls"
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        rowHref={(r) => `/calls/${r.id}`}
        selected={new Set()}
        onSelectChange={onSelectChange}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Select row a' });
    fireEvent.click(checkbox);
    expect(onSelectChange).toHaveBeenCalledWith(new Set(['a']));
  });
  it('shows the select-all checkbox as indeterminate for a partial selection', () => {
    render(
      <DataTableV2
        label="Calls"
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        selected={new Set(['a'])}
        onSelectChange={() => undefined}
      />,
    );
    const selectAll = screen.getByRole('checkbox', { name: 'Select all rows' }) as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(true);
  });
});

describe('RadioCardGroup', () => {
  it('selects a card by clicking its label and keeps the native radio in sync', () => {
    function Harness() {
      const [value, setValue] = useState('a');
      return (
        <RadioCardGroup
          name="demo"
          value={value}
          onChange={setValue}
          choices={[
            { value: 'a', title: 'A' },
            { value: 'b', title: 'B' },
          ]}
        />
      );
    }
    render(<Harness />);
    const radioB = screen.getByRole('radio', { name: /B/ }) as HTMLInputElement;
    fireEvent.click(radioB);
    expect(radioB.checked).toBe(true);
  });
});

describe('Tabs', () => {
  it('moves selection with the right arrow and wraps past the last tab', () => {
    function Harness() {
      const [current, setCurrent] = useState('one');
      return (
        <Tabs
          items={[
            { id: 'one', label: 'One' },
            { id: 'two', label: 'Two' },
          ]}
          current={current}
          onSelect={setCurrent}
        />
      );
    }
    render(<Harness />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'One' }).getAttribute('aria-selected')).toBe('true');
  });
});
