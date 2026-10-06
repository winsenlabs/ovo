import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerLoopFixture as fixture } from './worker-loop-fixture.ts';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// OPS-6: SIGTERM used to end the active call at once, so every redeploy hung up on a caller.
describe('SIGTERM drain', () => {
  it('lets an active outbound call finish, then shuts down without hanging it up', async () => {
    const subject = fixture(true, { drainTimeoutMs: 10_000 });
    await vi.waitFor(() => expect(subject.status.state).toBe('active'));
    subject.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subject.status.state).toBe('draining');
    expect(subject.events).toEqual([]);
    subject.endCall();
    await subject.running;
    expect(subject.events).not.toContain('fence');
    expect(subject.events).not.toContain('hangup');
    expect(subject.events).toEqual(
      expect.arrayContaining(['close-session', 'finalize', 'media-close', 'composition-close']),
    );
    // The fixture's first finishCall fails, so settlement (and finalize) runs a second time.
    expect(subject.finalize).toHaveBeenCalled();
    expect(subject.status.state).toBe('draining');
  }, 15_000);

  it('lets an active inbound call finish and never advertises the worker ready again', async () => {
    const subject = fixture(false, { inbound: true, drainTimeoutMs: 10_000 });
    await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
    await subject.admit();
    subject.events.length = 0;
    subject.shutdown();
    subject.releaseQueue();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subject.events).toEqual([]);
    subject.completeInbound();
    await subject.running;
    expect(subject.events).not.toContain('fence');
    expect(subject.events).toEqual(['protection-release', 'media-close', 'composition-close']);
    expect(subject.status.state).toBe('draining');
  }, 15_000);

  // The loop resumed from the admission before drain.wait() began, saw no drain waiting and
  // stopped supervising: the ended call then sat out the whole grace and was hung up.
  it('keeps supervising a call admitted after SIGTERM and settles it when it ends', async () => {
    const subject = fixture(true, { blockedDial: true, drainTimeoutMs: 10_000 });
    await vi.waitFor(() => expect(subject.status.state).toBe('reserved'));
    subject.shutdown();
    subject.releaseDial();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subject.events).toEqual([]);
    const endedAt = Date.now();
    subject.endCall();
    await subject.running;
    expect(Date.now() - endedAt).toBeLessThan(5_000);
    expect(subject.events).not.toContain('fence');
    expect(subject.events).not.toContain('hangup');
    expect(subject.events).toEqual(
      expect.arrayContaining(['close-session', 'finalize', 'media-close', 'composition-close']),
    );
  }, 15_000);

  it('terminates a call still running when the drain grace runs out', async () => {
    const subject = fixture(false, { inbound: true, drainTimeoutMs: 400 });
    await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
    await subject.admit();
    subject.events.length = 0;
    const startedAt = Date.now();
    subject.shutdown();
    subject.releaseQueue();
    await subject.running;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    expect(subject.events.slice(0, 2)).toEqual(['fence', 'hangup']);
  }, 15_000);
});
