import { describe, expect, it, vi } from 'vitest';
import { prepareSessionRecording } from '../src/session-recording.ts';

const media = { close: vi.fn() } as never;

describe('prepareSessionRecording', () => {
  it('uses original media and creates no artifact when immutable recording is disabled', async () => {
    const start = vi.fn();
    const result = await prepareSessionRecording(
      {
        enabled: false,
        media,
        workspaceId: 'workspace-1',
        callId: 'call-1',
        retentionDays: 30,
      },
      start,
    );
    expect(start).not.toHaveBeenCalled();
    expect(result).toEqual({
      media,
      finish: expect.any(Function),
      attachEvidence: expect.any(Function),
    });
  });

  it('requires and starts capture only when immutable recording is enabled', async () => {
    const capture = { finish: vi.fn(), attachEvidence: vi.fn() };
    const start = vi.fn(async () => capture as never);
    await expect(
      prepareSessionRecording(
        {
          enabled: true,
          media,
          workspaceId: 'workspace-1',
          callId: 'call-1',
          retentionDays: 30,
        },
        start,
      ),
    ).rejects.toThrow('production live recording service is not composed');

    const result = await prepareSessionRecording(
      {
        enabled: true,
        service: {} as never,
        media,
        workspaceId: 'workspace-1',
        callId: 'call-1',
        retentionDays: 30,
      },
      start,
    );
    expect(start).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ media: capture, capture });
  });

  it('writes live segments small enough that a crashed worker loses little audio', async () => {
    const start = vi.fn(async () => ({}) as never);
    await prepareSessionRecording(
      {
        enabled: true,
        service: {} as never,
        media,
        workspaceId: 'workspace-1',
        callId: 'call-1',
        retentionDays: 30,
      },
      start,
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentBytes: 256 * 1024,
        // Smaller segments do not shrink how long a stalled store is ridden out (~11 min, not ~32 s).
        maxQueuedBytes: 10 * 1024 * 1024,
      }),
    );
  });

  it('answers the call unrecorded when the recording store refuses to start one', async () => {
    const audit = vi.fn();
    const result = await prepareSessionRecording(
      {
        enabled: true,
        service: {} as never,
        media,
        workspaceId: 'workspace-1',
        callId: 'call-1',
        retentionDays: 30,
        audit,
      },
      vi.fn(async () => {
        throw new Error('Recording segment sequence exceeds manifest bound');
      }),
    );
    expect(result.media).toBe(media);
    expect(result.capture).toBeUndefined();
    await result.finish();
    expect(audit.mock.calls).toEqual([
      [
        'recording.status',
        {
          state: 'unavailable',
          error: 'Error: Recording segment sequence exceeds manifest bound',
        },
      ],
    ]);
  });
});
