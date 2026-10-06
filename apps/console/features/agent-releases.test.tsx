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
  it("shows the newest release's speech clip readiness", async () => {
    request.mockImplementation(async (path: string) => {
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
    expect(request).toHaveBeenCalledWith('/agents/agent-1/releases/release-new/speech-clips');
    expect(request).not.toHaveBeenCalledWith('/agents/agent-1/releases/release-old/speech-clips');
  });
});
