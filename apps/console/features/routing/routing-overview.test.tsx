import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { ClipManager } from '../../components/routing/clip-manager';
import { ENABLED_STATUS, IDS, resetRouting, routingApi } from './routing-test-support';
import { RoutingOverview } from './routing-overview';

vi.mock('../../lib/data/routing-api', async (importActual) =>
  (await import('./routing-test-support')).routingApiModule(importActual as never),
);
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
beforeEach(() => {
  resetRouting();
  push.mockReset();
});
afterEach(cleanup);

const view = (role: 'viewer' | 'editor' | 'admin' = 'editor') =>
  render(<RoutingOverview role={role} />);

describe('RoutingOverview', () => {
  it('shows KPIs from the stats, the chart with its table alternative and the points', async () => {
    view();
    expect(await screen.findByText('Routed calls', { selector: 'p' })).toBeTruthy();
    expect(await screen.findByText('474')).toBeTruthy();
    expect(screen.getByText('7.6%')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Table' })).toBeTruthy();
    expect(await screen.findByRole('row', { name: /Main line/ })).toBeTruthy();
    expect(screen.getAllByText('Unpublished changes').length).toBeGreaterThan(0);
    expect(routingApi.stats).toHaveBeenCalledWith('24h');
    fireEvent.change(screen.getByLabelText('Range'), { target: { value: '7d' } });
    await waitFor(() => expect(routingApi.stats).toHaveBeenCalledWith('7d'));
  });
  it('shows the unknown dash and a reason when call outcomes are not stored', async () => {
    routingApi.stats.mockResolvedValue({ available: false, window: '24h', totals: {}, series: [] });
    view();
    expect(await screen.findAllByText('Call outcomes are not stored here')).not.toHaveLength(0);
    expect(screen.getAllByTitle('Unknown').length).toBeGreaterThan(0);
  });
  it('keeps the page usable when only the stats fail', async () => {
    routingApi.stats.mockRejectedValue(new Error('stats down'));
    view();
    expect(await screen.findByText('stats down')).toBeTruthy();
    expect(await screen.findByRole('row', { name: /Main line/ })).toBeTruthy();
  });
  it.each([
    ['empty', () => routingApi.points.mockResolvedValue([]), 'No routing points yet'],
    ['error', () => routingApi.points.mockRejectedValue(new Error('points down')), 'points down'],
  ])('handles the %s points list', async (_name, arrange, text) => {
    arrange();
    view();
    expect(await screen.findByText(text)).toBeTruthy();
  });
  it('says routing is off, or could not be loaded, instead of an empty page', async () => {
    routingApi.status.mockResolvedValue({ ...ENABLED_STATUS, enabled: false });
    view();
    expect(await screen.findByText('Routing is not enabled here')).toBeTruthy();
    cleanup();
    routingApi.status.mockRejectedValue(new Error('status down'));
    view();
    expect(await screen.findByText('Routing could not be loaded')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
  it('lists pools with live load and used-by, and clips with their users', async () => {
    view();
    fireEvent.click(await screen.findByRole('tab', { name: 'Pools' }));
    expect(await screen.findByRole('row', { name: /Sales/ })).toBeTruthy();
    expect((await screen.findAllByText(/Main line/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Hold clips' }));
    expect(await screen.findByText('Please hold (Hindi)')).toBeTruthy();
  });
  it('creates a point and opens it in the designer', async () => {
    routingApi.createPoint.mockResolvedValue({ id: IDS.point2 });
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'New routing point' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create point' }));
    expect(screen.getByText(/Give the point a name/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Billing line' } });
    await screen.findAllByRole('option', { name: 'Front desk' });
    fireEvent.change(screen.getByLabelText('Router agent'), { target: { value: 'agent-front' } });
    fireEvent.change(screen.getByLabelText('Default agent'), {
      target: { value: 'agent-support' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create point' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/routing/points/${IDS.point2}`));
    const draft = routingApi.createPoint.mock.calls[0]![0];
    expect(draft).toMatchObject({
      name: 'Billing line',
      router: { agentId: 'agent-front' },
      defaultTarget: { agentId: 'agent-support' },
      root: 'start',
    });
  });
  it('creates a pool, naming a taken name plainly', async () => {
    routingApi.createPool.mockRejectedValue(new ApiError(409, 'routing_pool_name_taken', 'taken'));
    view();
    fireEvent.click(await screen.findByRole('button', { name: 'New pool' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sales' } });
    await screen.findAllByRole('option', { name: 'Front desk' });
    fireEvent.change(screen.getByLabelText('First member agent'), {
      target: { value: 'agent-front' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create pool' }));
    expect(await screen.findByText('Another pool already has this name.')).toBeTruthy();
  });
  it('gives viewers no create buttons', async () => {
    view('viewer');
    await screen.findByRole('row', { name: /Main line/ });
    expect(screen.queryByRole('button', { name: 'New routing point' })).toBeNull();
  });
});

describe('ClipManager', () => {
  const users = new Map([[IDS.clip, [{ id: IDS.point, name: 'Main line' }]]]);
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:clip');
    URL.revokeObjectURL = vi.fn();
  });
  it('previews a clip from a blob URL', async () => {
    routingApi.audioBlob.mockResolvedValue(new Blob(['x']));
    render(<ClipManager canEdit users={users} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Play Hold music' }));
    const audio = await screen.findByLabelText('Preview of Hold music');
    expect(audio.getAttribute('src')).toBe('blob:clip');
  });
  it('disables deleting a clip a point uses, and shows the API refusal with the points', async () => {
    render(<ClipManager canEdit users={users} />);
    expect(
      ((await screen.findByRole('button', { name: 'Delete Hold music' })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    routingApi.removeAudio.mockRejectedValue(
      new ApiError(409, 'routing_audio_in_use', 'in use', { inUseBy: [IDS.point] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Please hold (Hindi)' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete clip' })).getByRole('button', {
        name: 'Confirm',
      }),
    );
    expect(await screen.findByText(/still used by/)).toBeTruthy();
  });
  it('uploads a WAV with its name and refuses one over 10 MiB', async () => {
    routingApi.uploadAudio.mockResolvedValue({});
    render(<ClipManager canEdit />);
    const input = (await screen.findByLabelText(/Drop a WAV file/)) as HTMLInputElement;
    const big = new File([new Uint8Array(11 * 1024 * 1024)], 'big.wav', { type: 'audio/wav' });
    await act(async () => fireEvent.change(input, { target: { files: [big] } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload clip' }));
    expect(await screen.findByText('A clip is at most 10 MiB.')).toBeTruthy();
    const ok = new File(['RIFF'], 'welcome.wav', { type: 'audio/wav' });
    await act(async () => fireEvent.change(input, { target: { files: [ok] } }));
    fireEvent.click(await screen.findByRole('button', { name: 'Upload clip' }));
    await waitFor(() => expect(routingApi.uploadAudio).toHaveBeenCalledWith('welcome', ok));
  });
  it('is read only for viewers and shows an empty state', async () => {
    routingApi.audio.mockResolvedValue([]);
    render(<ClipManager canEdit={false} />);
    expect(await screen.findByText('No hold clips yet')).toBeTruthy();
    expect(screen.queryByLabelText(/Drop a WAV file/)).toBeNull();
  });
});
