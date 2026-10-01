import { describe, expect, it, vi } from 'vitest';
import { LiveRecordingCapture, encodeRecordingWav } from '../src/index.ts';
import { captureFixture, harness } from './production-fixtures.ts';

describe('recording audio format guards', () => {
  it.each([
    {
      name: 'an unsupported capture format',
      field: 'format',
      value: { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 },
      message: 'Live recording requires μ-law 8 kHz or PCM16 8/16 kHz media',
    },
    {
      name: 'a codec that disagrees with the capture format',
      field: 'codec',
      value: 'audio/pcm',
      message: 'Live recording media format and codec disagree',
    },
    {
      name: 'a sample rate that disagrees with the capture format',
      field: 'sampleRate',
      value: 16_000,
      message: 'Live recording media format and codec disagree',
    },
  ] as const)(
    'refuses $name before creating another recording',
    async ({ field, value, message }) => {
      const run = await captureFixture();
      const create = vi.spyOn(run.service, 'create');
      // Isolate the capture guard: the service has its own format guard.
      if (field === 'format') {
        create.mockResolvedValue(run.capture.artifact);
        Object.defineProperty(run.media, 'codec', { value: 'audio/pcm' });
        Object.defineProperty(run.media, 'sampleRate', { value: 48_000 });
      }
      Object.defineProperty(run.media, field, { value });
      await expect(
        LiveRecordingCapture.start({
          service: run.service,
          media: run.media,
          workspaceId: 'workspace',
          callId: 'invalid-capture',
          retentionDays: 1,
        }),
      ).rejects.toThrow(message);
      expect(create).not.toHaveBeenCalled();
      expect(await run.repository.list('workspace', 'invalid-capture')).toHaveLength(0);
      await run.capture.finish();
    },
  );

  it('refuses an odd PCM16 segment size before creating a recording', async () => {
    const run = await harness();
    await expect(
      run.service.create({
        workspaceId: 'workspace',
        callId: 'odd-segment',
        retentionDays: 1,
        segmentBytes: 64 * 1024 + 1,
        format: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
      }),
    ).rejects.toThrow('PCM16 segment size must preserve complete samples');
    expect(await run.repository.list('workspace', 'odd-segment')).toHaveLength(0);
  });

  it('refuses an unsupported service format before creating a recording', async () => {
    const run = await harness();
    await expect(
      run.service.create({
        workspaceId: 'workspace',
        callId: 'unsupported-format',
        retentionDays: 1,
        format: { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 },
      }),
    ).rejects.toThrow('Live recording requires μ-law 8 kHz or PCM16 8/16 kHz media');
    expect(await run.repository.list('workspace', 'unsupported-format')).toHaveLength(0);
  });

  it('refuses an odd PCM16 upload before writing an object', async () => {
    const run = await harness();
    const recording = await run.service.create({
      workspaceId: 'workspace',
      callId: 'odd-upload',
      retentionDays: 1,
      format: { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
    });
    await expect(
      run.service.writeSegment({
        recording,
        track: 'inbound',
        sequence: 0,
        bytes: Uint8Array.of(1),
        startMs: 0,
        endMs: 1,
      }),
    ).rejects.toThrow('PCM16 recording segment must contain complete samples');
    expect(run.objects.puts).toBe(0);
  });

  it('refuses an odd PCM16 WAV payload before encoding a header', () => {
    expect(() =>
      encodeRecordingWav(
        { encoding: 'pcm_s16le', sampleRate: 16_000, channels: 1 },
        Uint8Array.of(1),
      ),
    ).toThrow('Invalid recording WAV data length');
  });

  it('refuses an unsupported WAV format before encoding a header', () => {
    expect(() =>
      encodeRecordingWav(
        { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 },
        new Uint8Array(2),
      ),
    ).toThrow('Unsupported recording audio format');
  });
});
