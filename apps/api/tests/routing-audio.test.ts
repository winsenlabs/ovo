import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { RoutingPointDraft } from '@winsendotai/ovo-contracts';
import { decodeWav, mulawToPcm16 } from '@winsendotai/ovo-audio';
import { convertRoutingAudio, RoutingAudioRefusal } from '../src/routing-audio.ts';
import { draftInput, routingApp } from './routing-fixtures.ts';
import { pcmWav, wav } from './routing-audio-fixtures.ts';

function refusal(bytes: Uint8Array): RoutingAudioRefusal {
  try {
    convertRoutingAudio(bytes);
  } catch (error) {
    if (error instanceof RoutingAudioRefusal) return error;
    throw error;
  }
  throw new Error('converted');
}

describe('convertRoutingAudio', () => {
  it.each([8000, 11025, 16000, 22050, 32000, 44100, 48000])(
    'stores %i Hz PCM16 as 8 kHz μ-law of the same duration',
    (rate) => {
      const converted = convertRoutingAudio(pcmWav(rate, 0.5));
      expect(converted.audio.byteLength).toBe(4000);
      expect(converted.durationMs).toBe(500);
      expect(converted.source).toEqual({
        container: 'wav',
        encoding: 'pcm_s16le',
        sampleRate: rate,
        channels: 1,
      });
      expect(converted.sha256).toBe(createHash('sha256').update(converted.audio).digest('hex'));
      // The tone survives: its level after μ-law is the input level (8000 peak, ~5657 rms).
      const pcm = mulawToPcm16(converted.audio).subarray(400, 3600);
      const rms = Math.sqrt(pcm.reduce((sum, s) => sum + s * s, 0) / pcm.length);
      expect(rms).toBeGreaterThan(5400);
      expect(rms).toBeLessThan(5900);
    },
  );

  it('downmixes stereo to one channel', () => {
    const converted = convertRoutingAudio(pcmWav(16000, 0.25, 2));
    expect(converted.audio.byteLength).toBe(2000);
    expect(converted.source.channels).toBe(2);
  });

  it('reads PCM8, μ-law and A-law sources', () => {
    const pcm8 = convertRoutingAudio(
      wav({ rate: 8000, bits: 8, data: new Uint8Array(800).fill(128) }),
    );
    expect([pcm8.source.encoding, pcm8.audio.byteLength]).toEqual(['pcm_u8', 800]);
    // μ-law in at 8 kHz is stored byte for byte (decode then encode is exact for these codes).
    const codes = new Uint8Array(800).map((_, i) => (i % 2 ? 0x80 : 0x00));
    const mulaw = convertRoutingAudio(wav({ format: 7, rate: 8000, bits: 8, data: codes }));
    expect(mulaw.source.encoding).toBe('mulaw');
    expect([...mulaw.audio.subarray(0, 4)]).toEqual([0x00, 0x80, 0x00, 0x80]);
    const alaw = convertRoutingAudio(
      wav({ format: 6, rate: 8000, bits: 8, data: new Uint8Array(800).fill(0xd5) }),
    );
    expect(alaw.source.encoding).toBe('alaw');
  });

  it('bounds the stored clip to 0.1 s through 300 s', () => {
    expect(convertRoutingAudio(pcmWav(8000, 0.1)).durationMs).toBe(100);
    for (const bytes of [
      pcmWav(8000, 0.099),
      pcmWav(8000, 0),
      wav({ rate: 8000, bits: 8, data: new Uint8Array(300 * 8000 + 8) }),
    ])
      expect([refusal(bytes).status, refusal(bytes).code]).toEqual([422, 'routing_audio_invalid']);
    expect(
      convertRoutingAudio(wav({ rate: 8000, bits: 8, data: new Uint8Array(300 * 8000) }))
        .durationMs,
    ).toBe(300_000);
  });

  it('answers 415 for formats outside the list and 422 for malformed files', () => {
    const float = wav({ format: 3, rate: 8000, bits: 32, data: new Uint8Array(32_000) });
    expect([refusal(float).status, refusal(float).code]).toEqual([
      415,
      'routing_audio_unsupported',
    ]);
    const mp3 = Buffer.from('ID3\u0004\u0000\u0000 an mp3 file, not a wav');
    expect(refusal(mp3).status).toBe(415);
    const cut = pcmWav(8000, 0.5).subarray(0, 600);
    expect([refusal(cut).status, refusal(cut).code]).toEqual([422, 'routing_audio_invalid']);
  });
});

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function setup() {
  const built = routingApp();
  apps.push(built.app);
  const upload = (
    body: Buffer | string,
    query = '?name=Hold%20music',
    headers: Record<string, string> = {},
  ) =>
    built.app.inject({
      method: 'POST',
      url: `/v1/routing/audio${query}`,
      payload: body,
      headers: { 'content-type': 'audio/wav', ...headers },
    });
  const call = (method: 'GET' | 'DELETE', url: string, headers: Record<string, string> = {}) =>
    built.app.inject({ method, url, headers });
  return { ...built, upload, call };
}

describe('/v1/routing/audio', () => {
  it('uploads, lists, reads, previews and deletes a clip with audit', async () => {
    const { upload, call, store } = setup();
    const created = await upload(pcmWav(44100, 1, 2));
    expect(created.statusCode).toBe(201);
    const clip = created.json();
    expect(clip).toMatchObject({
      name: 'Hold music',
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      durationMs: 1000,
      byteLength: 8000,
      source: { container: 'wav', encoding: 'pcm_s16le', sampleRate: 44100, channels: 2 },
      createdBy: 'operator',
    });
    expect(clip).not.toHaveProperty('audio');
    expect(store.audits.at(-1)).toMatchObject({
      action: 'routing.audio.create',
      resourceType: 'routing_audio',
      resourceId: clip.id,
      payload: { name: 'Hold music', durationMs: 1000, sha256: clip.sha256, source: clip.source },
    });

    const listed = await call('GET', '/v1/routing/audio', { 'x-role': 'viewer' });
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([clip.id]);
    const read = await call('GET', `/v1/routing/audio/${clip.id}`, { 'x-role': 'viewer' });
    expect(read.json()).toEqual({ ...clip, usedBy: [] });

    const content = await call('GET', `/v1/routing/audio/${clip.id}/content`, {
      'x-role': 'viewer',
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('audio/wav');
    expect(content.headers['content-disposition']).toBe(`attachment; filename="${clip.id}.wav"`);
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    const preview = decodeWav(content.rawPayload);
    expect([preview.encoding, preview.sampleRate, preview.channels, preview.frames]).toEqual([
      'mulaw',
      8000,
      1,
      8000,
    ]);

    const removed = await call('DELETE', `/v1/routing/audio/${clip.id}`);
    expect(removed.statusCode).toBe(204);
    expect(store.audits.at(-1)).toMatchObject({
      action: 'routing.audio.delete',
      resourceId: clip.id,
    });
    expect((await call('GET', `/v1/routing/audio/${clip.id}`)).statusCode).toBe(404);
    expect((await call('GET', `/v1/routing/audio/${clip.id}/content`)).statusCode).toBe(404);
    expect((await call('DELETE', `/v1/routing/audio/${clip.id}`)).statusCode).toBe(404);
    expect((await call('GET', '/v1/routing/audio')).json().items).toEqual([]);
  });

  it('refuses a clip a point draft names with 409 routing_audio_in_use and usedBy', async () => {
    const { upload, call, routing } = setup();
    const clip = (await upload(pcmWav(8000, 1))).json();
    const draft = draftInput();
    draft.transfer = {
      hold: {
        steps: [{ kind: 'clip', assetId: clip.id }],
        onTimeout: [{ kind: 'default' }],
      },
    };
    const point = await routing.points.create(RoutingPointDraft.parse(draft));
    const read = await call('GET', `/v1/routing/audio/${clip.id}`);
    expect(read.json().usedBy).toEqual([point.id]);
    const removed = await call('DELETE', `/v1/routing/audio/${clip.id}`);
    expect([removed.statusCode, removed.json()]).toEqual([
      409,
      {
        error: { code: 'routing_audio_in_use', message: 'Point drafts still name this clip' },
        usedBy: [point.id],
      },
    ]);
  });

  it('answers 413 routing_audio_too_large before converting anything', async () => {
    const { upload } = setup();
    const response = await upload(Buffer.alloc(10 * 1024 * 1024 + 1));
    expect([response.statusCode, response.json().error.code]).toEqual([
      413,
      'routing_audio_too_large',
    ]);
  });

  it('answers 415 for another content type or a file that is not WAV', async () => {
    const { upload } = setup();
    for (const response of [
      await upload(pcmWav(8000, 1), undefined, { 'content-type': 'audio/mpeg' }),
      await upload(JSON.stringify({ audio: 'x' }), undefined, {
        'content-type': 'application/json',
      }),
      await upload(Buffer.from('ID3 not a wave file at all')),
    ])
      expect([response.statusCode, response.json().error.code]).toEqual([
        415,
        'routing_audio_unsupported',
      ]);
  });

  it('answers 422 for a malformed or out-of-bounds clip and 409 for a taken name', async () => {
    const { upload } = setup();
    const short = await upload(pcmWav(8000, 0.05));
    expect([short.statusCode, short.json().error.code]).toEqual([422, 'routing_audio_invalid']);
    const cut = await upload(pcmWav(8000, 1).subarray(0, 900));
    expect([cut.statusCode, cut.json().error.code]).toEqual([422, 'routing_audio_invalid']);
    expect((await upload(pcmWav(8000, 1))).statusCode).toBe(201);
    const taken = await upload(pcmWav(8000, 1), '?name=HOLD%20MUSIC');
    expect([taken.statusCode, taken.json().error.code]).toEqual([409, 'routing_audio_name_taken']);
    const unnamed = await upload(pcmWav(8000, 1), '');
    expect([unnamed.statusCode, unnamed.json().error.code]).toEqual([400, 'validation_error']);
  });

  it('lets only editors upload or delete', async () => {
    const { upload, call } = setup();
    expect((await upload(pcmWav(8000, 1), undefined, { 'x-role': 'viewer' })).statusCode).toBe(403);
    const id = '99999999-9999-4999-8999-999999999999';
    expect(
      (await call('DELETE', `/v1/routing/audio/${id}`, { 'x-role': 'viewer' })).statusCode,
    ).toBe(403);
  });
});
