import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentReleasesFeature } from './agent-releases';

const request = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api')>()),
  apiRequest: request,
}));
afterEach(() => cleanup());

describe('AgentReleasesFeature', () => {
  it("shows the routed release's speech clip readiness, not only the newest", async () => {
    request.mockImplementation(async (path: string) => {
      if (path === '/operations/inbound/routes?limit=100')
        return {
          data: { items: [{ releaseId: 'release-old', phoneNumber: '+1', enabled: true }] },
        };
      if (path === '/operations/campaigns?limit=100') return { data: { items: [] } };
      if (path === '/agents/agent-1/releases')
        return {
          data: {
            items: [
              { id: 'release-old', selections: {} },
              { id: 'release-new', selections: {} },
            ],
          },
        };
      return {
        data: {
          state: 'done',
          total: 3,
          ready: 3,
          failed: 0,
          pending: 0,
          perCall: 0,
          inventorySha256: null,
          detail: null,
          requestedAt: null,
          finishedAt: null,
        },
      };
    });
    render(<AgentReleasesFeature agentId="agent-1" />);
    expect(await screen.findByText('3 of 3')).toBeTruthy();
    expect(request).toHaveBeenCalledWith('/agents/agent-1/releases/release-old/speech-clips');
    expect(request).not.toHaveBeenCalledWith('/agents/agent-1/releases/release-new/speech-clips');
  });
});
