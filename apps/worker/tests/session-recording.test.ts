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
    expect(result).toEqual({ media });
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
    expect(result).toEqual({ media: capture, capture });
  });
});
