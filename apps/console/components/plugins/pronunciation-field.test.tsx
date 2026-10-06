import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { elevenLabsTtsPlugin } from '../../../../packages/plugin-tts-elevenlabs/src/index.ts';
import { SchemaForm } from './schema-form';
import type { PluginOption } from './types';

afterEach(() => cleanup());

/** The plugin as the API's /plugins route lists it: the real ElevenLabs manifest. */
const plugin = {
  ...elevenLabsTtsPlugin.manifest,
  available: true,
} as unknown as PluginOption;

function Harness({
  initial,
  onValue,
}: {
  initial: Record<string, unknown>;
  onValue: (value: Record<string, unknown>) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SchemaForm
      plugin={plugin}
      value={value}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe('ElevenLabs pronunciation dictionaries in the binding form', () => {
  it('is a visible field with an id and version per dictionary', () => {
    const values: Record<string, unknown>[] = [];
    render(<Harness initial={{}} onValue={(value) => values.push(value)} />);
    expect(screen.getByRole('group', { name: 'Pronunciation dictionaries' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Dictionary 1 ID'), { target: { value: ' dict_a ' } });
    fireEvent.change(screen.getByLabelText('Version'), { target: { value: 'v3' } });
    expect(values.at(-1)?.pronunciationDictionaries).toEqual([{ id: 'dict_a', versionId: 'v3' }]);
  });

  it('adds up to three rows, never saves a row without an id, and removes rows', () => {
    const onValue = vi.fn();
    render(
      <Harness initial={{ pronunciationDictionaries: [{ id: 'dict_a' }] }} onValue={onValue} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add dictionary' }));
    expect(onValue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add dictionary' }));
    expect(screen.queryByRole('button', { name: 'Add dictionary' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Dictionary 3 ID'), { target: { value: 'dict_c' } });
    expect(onValue.mock.lastCall?.[0].pronunciationDictionaries).toEqual([
      { id: 'dict_a' },
      { id: 'dict_c' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove dictionary 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove dictionary 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove dictionary 1' }));
    expect(onValue.mock.lastCall?.[0].pronunciationDictionaries).toBeUndefined();
  });
});
