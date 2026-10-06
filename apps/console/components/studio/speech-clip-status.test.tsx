import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechClipStatusPanel, type SpeechClipStatus } from './speech-clip-status';

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
