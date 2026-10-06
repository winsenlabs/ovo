import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RoutedSpeechClipStatus,
  SpeechClipStatusPanel,
  type SpeechClipStatus,
} from './speech-clip-status';

afterEach(() => cleanup());

const status = (patch: Partial<SpeechClipStatus>): SpeechClipStatus => ({
  state: 'done',
  total: 12,
  ready: 12,
  failed: 0,
  pending: 0,
  perCall: 0,
  inventorySha256: 'a'.repeat(64),
  detail: null,
  requestedAt: null,
  finishedAt: null,
  ...patch,
});

describe('SpeechClipStatusPanel', () => {
  it('shows how many fixed lines are ready for the release', async () => {
    const load = vi.fn(async () => status({ perCall: 2 }));
    render(<SpeechClipStatusPanel agentId="agent-1" releaseId="release-1" load={load} />);
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByText('12 of 12')).toBeTruthy();
    expect(
      screen.getByText(/2 templated lines with caller variables are synthesized/),
    ).toBeTruthy();
    expect(load).toHaveBeenCalledWith('agent-1', 'release-1');
  });

  it('polls while a render is running and reports failed lines', async () => {
    const load = vi
      .fn<(agentId: string, releaseId: string) => Promise<SpeechClipStatus>>()
      .mockResolvedValueOnce(status({ state: 'running', ready: 3, pending: 9 }))
      .mockResolvedValue(
        status({ state: 'failed', ready: 11, failed: 1, detail: '1 of 12 failed' }),
      );
    render(
      <SpeechClipStatusPanel agentId="agent-1" releaseId="release-1" load={load} pollMs={5} />,
    );
    expect(await screen.findByText('Rendering')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Some lines failed')).toBeTruthy());
    expect(screen.getByText('1 of 12 failed')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('surfaces a load error', async () => {
    render(
      <SpeechClipStatusPanel
        agentId="agent-1"
        releaseId="release-1"
        load={async () => {
          throw new Error('Release not found');
        }}
      />,
    );
    expect(await screen.findByText('Release not found')).toBeTruthy();
  });
});

describe('RoutedSpeechClipStatus', () => {
  const releases = [{ id: 'release-old' }, { id: 'release-mid' }, { id: 'release-new' }];

  it('shows the releases calls are routed to, not just the newest', async () => {
    // Wave 2 minor: a number still routed to an older release showed the newest one's clips.
    const load = vi.fn(async () => status({}));
    const routed = async () =>
      new Map([
        ['release-old', ['+918000000001']],
        ['release-mid', ['campaign June EMI']],
      ]);
    render(
      <RoutedSpeechClipStatus
        agentId="agent-1"
        releases={releases}
        load={load}
        routedReleases={routed}
      />,
    );
    expect(
      await screen.findByText('Release release-mid, routed from campaign June EMI.'),
    ).toBeTruthy();
    expect(screen.getByText('Release release-old, routed from +918000000001.')).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(load).toHaveBeenCalledWith('agent-1', 'release-old');
    expect(load).toHaveBeenCalledWith('agent-1', 'release-mid');
    expect(load).not.toHaveBeenCalledWith('agent-1', 'release-new');
    // Newest routed release first.
    const captions = screen.getAllByText(/^Release release-/).map((node) => node.textContent);
    expect(captions[0]).toContain('release-mid');
  });

  it('falls back to the newest release, labelled, when nothing routes or routes cannot load', async () => {
    const load = vi.fn(async () => status({}));
    const failing = async () => {
      throw new Error('forbidden');
    };
    render(
      <RoutedSpeechClipStatus
        agentId="agent-1"
        releases={releases}
        load={load}
        routedReleases={failing}
      />,
    );
    expect(
      await screen.findByText(
        'Newest release release-new; no number or campaign routes to it yet.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(load).toHaveBeenCalledWith('agent-1', 'release-new'));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
