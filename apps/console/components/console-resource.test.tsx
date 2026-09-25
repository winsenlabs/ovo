import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cacheSet } from '../lib/data/cache';
import { useMutation } from '../lib/data/use-mutation';
import { useResource } from '../lib/data/use-resource';

afterEach(() => cleanup());

describe('shared console resource and mutation', () => {
  it('reuses a scoped cached load and refreshes the mounted view after mutation invalidation', async () => {
    let version = 1;
    const load = vi.fn(async () => ({ version }));
    function Surface({ workspace }: { workspace: string }) {
      const key = `plugins:test-${workspace}`;
      const resource = useResource(key, load, 60_000);
      const mutation = useMutation(async () => { version++; }, [key]);
      return <><output data-testid="version">{resource.status === 'ready' ? resource.data.version : resource.status}</output>
        <button onClick={() => void mutation.run(undefined)}>Update plugins</button></>;
    }
    const view = render(<Surface workspace="one" />);
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('1'));
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<Surface workspace="one" />);
    expect(load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Update plugins' }));
    await waitFor(() => expect(screen.getByTestId('version').textContent).toBe('2'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not show another workspace cache while its own resource loads', async () => {
    cacheSet('plugins:test-workspace-A', { version: 'A' });
    let finish!: (value: { version: string }) => void;
    const load = () => new Promise<{ version: string }>(resolve => { finish = resolve; });
    function Surface({ workspace }: { workspace: string }) {
      const resource = useResource(`plugins:test-workspace-${workspace}`, load, 60_000);
      return <output>{resource.status === 'ready' ? resource.data.version : resource.status}</output>;
    }
    const view = render(<Surface workspace="A" />);
    expect(screen.getByText('A')).toBeDefined();
    view.rerender(<Surface workspace="B" />);
    expect(screen.queryByText('A')).toBeNull();
    expect(screen.getByText('loading')).toBeDefined();
    finish({ version: 'B' });
    await waitFor(() => expect(screen.getByText('B')).toBeDefined());
  });
});
