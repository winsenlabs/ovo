import { beforeEach, expect, it, vi } from 'vitest';
import { loadAgentReleaseOptions } from './agent-release-options';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  apiRequest: request,
}));

beforeEach(() => {
  request.mockReset();
});

it('includes an agent beyond the first cursor page and its later release page', async () => {
  request.mockImplementation(async (path: string) => {
    if (path === '/agents')
      return { data: { items: [{ id: 'agent-001', name: 'First' }], nextCursor: 'next' } };
    if (path === '/agents?cursor=next')
      return { data: { items: [{ id: 'agent-101', name: 'Later' }], nextCursor: null } };
    if (path === '/agents/agent-001/releases') return { data: { items: [] } };
    if (path === '/agents/agent-101/releases') return { data: { items: [], nextCursor: 'more' } };
    if (path === '/agents/agent-101/releases?cursor=more')
      return { data: { items: [{ id: 'release-101' }] } };
    throw new Error(`Unexpected request ${path}`);
  });
  expect(await loadAgentReleaseOptions()).toEqual([{ id: 'release-101', agentName: 'Later' }]);
  expect(request).toHaveBeenCalledWith('/agents?cursor=next');
});

it('retains another agent release when one history fails, but fails if all fail', async () => {
  request.mockImplementation(async (path: string) => {
    if (path === '/agents') return { data: { items: [{ id: 'broken' }, { id: 'healthy' }] } };
    if (path === '/agents/broken/releases') throw new Error('Broken agent history');
    if (path === '/agents/healthy/releases')
      return { data: { items: [{ id: 'healthy-release' }] } };
    throw new Error(`Unexpected request ${path}`);
  });
  expect(await loadAgentReleaseOptions()).toEqual([
    { id: 'healthy-release', agentName: 'healthy' },
  ]);
  request.mockImplementation(async (path: string) => {
    if (path === '/agents') return { data: { items: [{ id: 'broken' }] } };
    throw new Error('Broken agent history');
  });
  await expect(loadAgentReleaseOptions()).rejects.toThrow('Broken agent history');
});
