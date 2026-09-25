import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SchemaForm } from './plugins/schema-form';
import { CompatSummary } from './plugins/compat-summary';
import { BindingSelect } from './plugins/binding-select';
import { SlotPicker } from './plugins/slot-picker';
import type { CompatIssue } from './plugins/types';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async importOriginal => ({ ...(await importOriginal<typeof import('../lib/api')>()), apiRequest: request }));
beforeEach(() => request.mockReset());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const plugin = { id: 'carrier-fixture', version: '1.0.0', kind: 'carrier', provider: 'fixture', available: true, ui: { label: 'Fixture carrier' } };
const voice = { textFilters: [], acknowledgements: [] };
const issue = (code: string, slot = 'carrier'): CompatIssue => ({ code, stage: 'release', severity: 'error', slot, message: `${code} message` } as CompatIssue);

describe('manifest-driven console controls', () => {
  it('shows carrier operator URLs from the selected binding, with copy controls', async () => {
    request.mockResolvedValue({ data: { items: [{ purpose: 'answer', label: 'Answer URL', url: 'https://fixture.test/answer?t=opaque' }] } });
    const copy = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copy } });
    render(<BindingSelect plugin={plugin} value="binding-1" bindings={[{ id: 'binding-1', label: 'Carrier one', provider: 'fixture', pluginId: 'carrier-fixture', credentialId: 'c1', environment: 'test' }, { id: 'binding-other', label: 'Other carrier', provider: 'other', pluginId: 'other', credentialId: 'c2', environment: 'test' }]} credentials={[]} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: 'Carrier one' })).toBeDefined();
    expect(screen.queryByRole('option', { name: 'Other carrier' })).toBeNull();
    await waitFor(() => expect(screen.getByText('https://fixture.test/answer?t=opaque')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith('https://fixture.test/answer?t=opaque'));
  });

  it('shows no operator URLs for an environment binding', () => {
    render(<BindingSelect plugin={plugin} bindings={[]} credentials={[]} onChange={vi.fn()} />);
    expect(request).not.toHaveBeenCalled();
    expect(screen.queryByText('Operator URLs')).toBeNull();
  });

  it('renders enum, bounded number, switch, and advanced disclosure from the schema', () => {
    const onChange = vi.fn();
    render(<SchemaForm plugin={plugin} value={{}} onChange={onChange} schema={{ properties: { region: { enum: ['in', 'us'] }, timeout: { type: 'number', minimum: 1, maximum: 10 }, active: { type: 'boolean' } } }} />);
    fireEvent.change(screen.getByLabelText('region'), { target: { value: 'in' } });
    expect(onChange).toHaveBeenCalledWith({ region: 'in' });
    const timeout = screen.getByLabelText('timeout') as HTMLInputElement;
    expect(timeout.min).toBe('1');
    expect(timeout.max).toBe('10');
    fireEvent.change(timeout, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith({ timeout: 7 });
    expect(screen.getByRole('switch')).toBeDefined();
    expect(screen.getByText('Advanced JSON')).toBeDefined();
  });

  it('groups compatibility issues by stage and links back to the slot', () => {
    render(<CompatSummary issues={[issue('format_unreachable'), issue('binding_missing', 'engine')]} voice={voice} onChange={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'release · carrier' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'format_unreachable message' }).getAttribute('href')).toBe('#slot-carrier');
    expect(screen.getByRole('link', { name: 'binding_missing message' }).getAttribute('href')).toBe('#slot-engine');
  });

  it('only presents weak playback acknowledgement for the matching issue', () => {
    const change = vi.fn();
    const view = render(<CompatSummary issues={[issue('format_unreachable')]} voice={voice} onChange={change} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    view.rerender(<CompatSummary issues={[issue('playback_evidence_insufficient')]} voice={voice} onChange={change} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(change).toHaveBeenCalledWith({ ...voice, acknowledgements: ['weak-playback-evidence'] });
  });


  it('hides the LLM slot for announcement and FAQ modes', () => {
    const view = render(<SlotPicker slot="llm" plugins={[{ id: 'llm-fixture', version: '1', kind: 'llm', available: true }]} voice={voice} mode="announcement" language="en-IN" onChange={vi.fn()} />);
    expect(screen.queryByRole('group')).toBeNull();
    view.rerender(<SlotPicker slot="llm" plugins={[{ id: 'llm-fixture', version: '1', kind: 'llm', available: true }]} voice={voice} mode="faq" language="en-IN" onChange={vi.fn()} />);
    expect(screen.queryByRole('group')).toBeNull();
  });
});
