import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useEditableRecord } from './use-editable-record';

interface Rec {
  text: string;
  v: number;
}
interface Draft {
  text: string;
}

// The hook's callbacks must be stable, as they are on the real screens.
const load = async () => ({ record: { text: 'a', v: 1 }, version: 1 });
const toDraft = (r: Rec): Draft => ({ text: r.text });
const versionOf = (r: Rec) => r.v;
const hook = (save: (draft: Draft, version: number) => Promise<Rec>) =>
  renderHook(() =>
    useEditableRecord<Rec, Draft>({
      load,
      toDraft,
      save,
      versionOf,
      notFoundCode: 'nf',
      conflictCode: 'conflict',
    }),
  );
afterEach(cleanup);

describe('useEditableRecord', () => {
  it('keeps edits typed while a save was in flight, and stays dirty', async () => {
    let release!: (rec: Rec) => void;
    const save = () => new Promise<Rec>((resolve) => (release = resolve));
    const { result } = hook(save);
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    act(() => result.current.edit(() => ({ text: 'b' })));
    let saved!: Promise<boolean>;
    act(() => {
      saved = result.current.save();
    });
    act(() => result.current.edit(() => ({ text: 'bc' })));
    await act(async () => {
      release({ text: 'b', v: 2 });
      await saved;
    });
    expect(result.current.draft).toEqual({ text: 'bc' });
    expect(result.current.saved).toEqual({ text: 'b' });
    expect(result.current.version).toBe(2);
    expect(result.current.dirty).toBe(true);
  });

  it('adopts the server copy when nothing changed during the save', async () => {
    const { result } = hook(async () => ({ text: 'normalised', v: 2 }));
    await waitFor(() => expect(result.current.phase).toBe('ready'));
    act(() => result.current.edit(() => ({ text: 'b' })));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.draft).toEqual({ text: 'normalised' });
    expect(result.current.dirty).toBe(false);
  });
});
