import { afterEach, describe, expect, it, vi } from 'vitest';
import { workerLoopFixture as fixture } from './worker-loop-fixture.ts';

describe('runWorkerLoop forced exit cost settlement', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('finalizes cost after the real loop termination callback handles lease loss', async () => {
    const subject = fixture(false);
    await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
    await subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost');
    expect(subject.events.slice(0, 5)).toEqual([
      'fence',
      'hangup',
      'media',
      'close-session',
      'finalize',
    ]);
    expect(subject.finalize).toHaveBeenCalledOnce();
    subject.shutdown();
    subject.releaseQueue();
    await subject.running;
  });

  it.each([false, true])(
    'releases inbound session state after forced job lease loss (termination fails: %s)',
    async (terminationFails) => {
      const subject = fixture(false, { inbound: true, terminationFails });
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      await subject.admit();
      expect(subject.status.state).toBe('active');

      if (terminationFails)
        await expect(
          subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost'),
        ).rejects.toThrow('selected carrier unavailable');
      else await subject.terminate('00000000-0000-4000-8000-000000000001', 1, 'job-lease-lost');
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      expect(subject.status.detail).toBe('Inbound session closed');
      expect(subject.events.slice(0, terminationFails ? 4 : 5)).toEqual([
        'floor-release',
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
      ]);
      subject.shutdown();
      subject.releaseQueue();
      await subject.running;
    },
  );

  it.each(['none', 'termination', 'finalization'])(
    'closes outbound shutdown resources despite %s failure',
    async (failure) => {
      const terminationFails = failure === 'termination';
      const subject = fixture(true, {
        terminationFails,
        finalizeFails: failure === 'finalization',
      });
      await vi.waitFor(() => expect(subject.status.state).toBe('active'));
      subject.status.state = 'draining';
      await subject.running.catch(() => undefined);
      expect(subject.events).toEqual([
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
        'finalize',
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledOnce();
      expect(subject.stopLease).toHaveBeenCalledOnce();
      expect(subject.releaseProtection).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    'finalizes active inbound shutdown before protection release (termination fails: %s)',
    async (terminationFails) => {
      const subject = fixture(false, { inbound: true, terminationFails });
      await vi.waitFor(() => expect(subject.status.state).toBe('ready'));
      await subject.admit();
      subject.events.length = 0;
      subject.shutdown();
      subject.releaseQueue();
      await subject.running;
      expect(subject.events).toEqual([
        'fence',
        ...(terminationFails ? [] : ['hangup']),
        'media',
        'close-session',
        'finalize',
        'protection-release',
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledOnce();
      if (terminationFails) expect(subject.status.detail).toContain('selected carrier unavailable');
    },
  );

  // OBS-4: a failed finishCall was retried every second with no log, so a stuck call was silent.
  it('logs a failed finishCall with its IDs before retrying it', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const subject = fixture(true);
    await vi.waitFor(() => expect(subject.status.state).toBe('active'));
    subject.endCall();
    await vi.waitFor(() => expect(subject.status.detail).toBe('terminal session released'), {
      timeout: 5_000,
    });
    const lines = [...stderr.mock.calls, ...stdout.mock.calls].map(([line]) =>
      JSON.parse(String(line)),
    );
    expect(subject.finishCall).toHaveBeenCalledTimes(2);
    expect(lines).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        event: 'call_finish_failed',
        service: 'worker',
        workerId: 'worker-1',
        jobId: '00000000-0000-4000-8000-000000000001',
        callId: '00000000-0000-4000-8000-000000000001',
        status: 'completed',
        error: 'control database unavailable',
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ event: 'session_released', status: 'completed' }),
    );
    subject.shutdown();
    subject.releaseQueue();
    await subject.running;
    stderr.mockRestore();
    stdout.mockRestore();
  });

  it('keeps periodic reports reserved throughout a blocked outbound dial', async () => {
    vi.useFakeTimers();
    const subject = fixture(true, { blockedDial: true });
    await vi.waitFor(() => expect(subject.reports).toContain('reserved'));
    await vi.advanceTimersByTimeAsync(10_000);
    const reportsWhileDialing = [...subject.reports];
    subject.releaseDial();
    await vi.waitFor(() => expect(subject.status.state).toBe('active'));
    subject.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    await subject.running;
    expect(reportsWhileDialing).toEqual(['ready_idle', 'reserved', 'reserved', 'reserved']);
    expect(subject.reports).toContain('active');
    expect(subject.reports.at(-1)).toBe('draining');
  });
  it.each([false, true])(
    'waits for an in-flight dial on shutdown (unknown outcome: %s)',
    async (unknownDial) => {
      vi.useFakeTimers();
      const subject = fixture(true, { blockedDial: true, unknownDial });
      await vi.waitFor(() => expect(subject.reports).toContain('reserved'));
      subject.shutdown();
      await vi.advanceTimersByTimeAsync(1);
      const beforeDialSettles = [...subject.events];
      subject.releaseDial();
      await vi.advanceTimersByTimeAsync(1_000);
      const stateAfterDialSettles = subject.status.state;
      if (stateAfterDialSettles !== 'draining') subject.status.state = 'draining';
      subject.releaseQueue();
      await vi.advanceTimersByTimeAsync(1_000);
      await subject.running;
      expect(beforeDialSettles).toEqual([]);
      expect(stateAfterDialSettles).toBe('draining');
      expect(subject.events).toEqual([
        ...(unknownDial ? [] : ['fence', 'hangup', 'media', 'close-session', 'finalize']),
        'media-close',
        'composition-close',
      ]);
      expect(subject.finalize).toHaveBeenCalledTimes(unknownDial ? 0 : 1);
      expect(subject.reports).not.toContain('active');
    },
  );
});
