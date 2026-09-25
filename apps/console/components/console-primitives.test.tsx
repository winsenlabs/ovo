import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { FormField } from './ui/form-field';
import { JsonEditor } from './forms/json-editor';
import { useFormAction } from './forms/use-form-action';
import { useRowKeys } from './forms/use-row-keys';
import { ListTextInput } from './forms/list-text-input';
import { SchemaForm } from './plugins/schema-form';
import { SlotPicker } from './plugins/slot-picker';
import { ConfirmDialog } from './ui/dialog';
import { safeReturnPath } from '../features/login';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('console form and plugin primitives', () => {
  it('puts help and error references on the real form control', () => {
    render(<FormField id="number" label="Number" help="E.164" error="Invalid" required>{props => <input {...props} />}</FormField>);
    const control = screen.getByLabelText('Number');
    expect(control.getAttribute('aria-describedby')).toBe('number-help number-error');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.hasAttribute('required')).toBe(true);
  });

  it('preserves invalid JSON across a parent rerender and reports it on blur', () => {
    const onValid = vi.fn();
    const view = render(<JsonEditor id="json" value={{ a: 1 }} onValid={onValid} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '{broken' } });
    view.rerender(<JsonEditor id="json" value={{ a: 2 }} onValid={onValid} />);
    expect((input as HTMLTextAreaElement).value).toBe('{broken');
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onValid).not.toHaveBeenCalled();
  });

  it('captures the form before await and resets only after successful submit', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    function Example() {
      const action = useFormAction();
      return <form onSubmit={event => { void action(event, async () => pending); }}><input aria-label="Value" defaultValue="" /><button>Save</button></form>;
    }
    render(<Example />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'changed' } });
    fireEvent.submit(input.closest('form')!);
    expect(input.value).toBe('changed');
    finish();
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('keeps an edited row mounted and focused while its id changes', () => {
    function Rows() {
      const [items, setItems] = useState([{ id: 'first' }]);
      const keys = useRowKeys(items.length);
      return <>{items.map((item, index) => <input aria-label="Row id" key={keys.keyAt(index)} value={item.id} onChange={event => setItems([{ id: event.target.value }])} />)}</>;
    }
    render(<Rows />);
    const control = screen.getByRole('textbox');
    control.focus();
    fireEvent.change(control, { target: { value: 'second' } });
    expect(screen.getByRole('textbox')).toBe(control);
    expect(document.activeElement).toBe(control);
  });

  it('keeps list text raw until blur', () => {
    const onChange = vi.fn();
    render(<ListTextInput id="aliases" value={['one']} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'one,\ntwo,' } });
    expect(input.value).toBe('one,\ntwo,');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(['one', 'two']);
  });

  it('renders a required const attestation and write-only secret control', () => {
    const onSecret = vi.fn();
    render(<SchemaForm plugin={{ id: 'carrier', version: '1.0.0', kind: 'carrier', available: true, secretFields: ['/token'] }}
      schema={{ properties: { streamEndTerminatesCall: { const: true }, token: { type: 'string' } }, required: ['streamEndTerminatesCall'] }}
      value={{ streamEndTerminatesCall: false }} onChange={vi.fn()} onSecret={onSecret} fingerprints={{ token: 'abc123' }} />);
    const attestation = screen.getByRole('checkbox') as HTMLInputElement;
    expect(attestation.required).toBe(true);
    const secret = screen.getByLabelText('token') as HTMLInputElement;
    expect(secret.type).toBe('password');
    expect(secret.autocomplete).toBe('off');
    expect(screen.getByText(/Stored · fingerprint abc123/)).toBeDefined();
    fireEvent.change(secret, { target: { value: 'new-secret' } });
    fireEvent.blur(secret);
    expect(onSecret).toHaveBeenCalledWith('/token', 'new-secret');
    expect(secret.value).toBe('');
  });

  it('keeps an incompatible plugin visible with a linked reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify([{ code: 'format_unreachable', severity: 'error', stage: 'live', slot: 'stt', pluginId: 'bad-stt', message: 'Audio format unreachable' }]) })));
    render(<SlotPicker slot="stt" plugins={[{ id: 'bad-stt', version: '1.0.0', kind: 'stt', available: true, ui: { label: 'Bad STT' } }]}
      voice={{ textFilters: [], acknowledgements: [] }} mode="announcement" language="en-IN" onChange={vi.fn()} />);
    const card = screen.getByRole('radio', { name: /Bad STT/i }) as HTMLInputElement;
    await waitFor(() => expect(card.disabled).toBe(true));
    const reason = document.getElementById(card.getAttribute('aria-describedby')!);
    expect(reason?.textContent).toBe('Audio format unreachable');
  });

  it('does not leave the origin through a crafted login next path', () => {
    expect(safeReturnPath('/\\evil.example')).toBe('/agents');
    expect(safeReturnPath('//evil.example')).toBe('/agents');
    expect(safeReturnPath('/%5cevil.example')).toBe('/agents');
    expect(safeReturnPath('/calls?id=1')).toBe('/calls?id=1');
  });

  it('settles Escape confirmation once when cancel and close both fire', () => {
    vi.stubGlobal('HTMLDialogElement', HTMLDialogElement);
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    const choice = vi.fn();
    render(<ConfirmDialog open title="Delete" message="Sure?" onChoice={choice} />);
    const dialog = screen.getByRole('dialog');
    fireEvent(dialog, new Event('cancel'));
    fireEvent(dialog, new Event('close'));
    expect(choice).toHaveBeenCalledTimes(1);
    expect(choice).toHaveBeenCalledWith(false);
  });

  it('preserves form data after a rejected async submit', async () => {
    function Example() {
      const action = useFormAction();
      return <form onSubmit={event => { void action(event, async () => { throw new Error('rejected'); }).catch(() => undefined); }}><input aria-label="Value" defaultValue="" /><button>Save</button></form>;
    }
    render(<Example />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'keep me' } });
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(input.value).toBe('keep me'));
  });

  it('keeps neighboring row keys stable on insert and removal', () => {
    function Rows() {
      const [items, setItems] = useState(['first', 'second']);
      const keys = useRowKeys(items.length);
      return <><div>{items.map((item, index) => <input aria-label={item} key={keys.keyAt(index)} defaultValue={item} />)}</div>
        <button onClick={() => { keys.insert(1); setItems(['first', 'middle', 'second']); }}>Insert</button>
        <button onClick={() => { keys.remove(1); setItems(['first', 'second']); }}>Remove</button></>;
    }
    render(<Rows />);
    const first = screen.getByLabelText('first');
    const second = screen.getByLabelText('second');
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    expect(screen.getByLabelText('first')).toBe(first);
    expect(screen.getByLabelText('second')).toBe(second);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByLabelText('second')).toBe(second);
  });

  it('rejects JSON arrays when a configuration object is required', () => {
    const onValid = vi.fn();
    render(<JsonEditor id="config" value={{}} onValid={onValid} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '[]' } });
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a valid JSON object.')).toBeDefined();
    expect(onValid).not.toHaveBeenCalled();
  });

  it('allows a valid JSON array only for a non-object editor', () => {
    const onValid = vi.fn();
    render(<JsonEditor id="list" value={[]} onValid={onValid} objectOnly={false} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '["one"]' } });
    fireEvent.blur(input);
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(onValid).toHaveBeenCalledWith(['one']);
  });
});
