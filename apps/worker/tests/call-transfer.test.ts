import { describe, expect, it, vi } from 'vitest';
import { releaseTransferTarget } from '../src/call-transfer.ts';

describe('the transfer target of a call (AGT-15)', () => {
  const target = { kind: 'phone' as const, e164: '+918041234567' };
  const store = (config: Record<string, unknown>) => ({
    getRelease: vi.fn(async () => ({ config }) as never),
  });

  it("reads the target of the release the job ran, in the job's workspace", async () => {
    const releases = store({ handoff: { transfer: { target } } });
    await expect(
      releaseTransferTarget(releases, { workspaceId: 'w-1', payload: { releaseId: 'r-1' } }),
    ).resolves.toEqual(target);
    expect(releases.getRelease).toHaveBeenCalledWith('w-1', 'r-1');
  });

  it('is undefined for a release without a transfer, or a job without a release', async () => {
    await expect(
      releaseTransferTarget(store({}), { workspaceId: 'w-1', payload: { releaseId: 'r-1' } }),
    ).resolves.toBeUndefined();
    const releases = store({ handoff: { transfer: { target } } });
    await expect(
      releaseTransferTarget(releases, { workspaceId: 'w-1', payload: {} }),
    ).resolves.toBeUndefined();
    expect(releases.getRelease).not.toHaveBeenCalled();
  });
});
