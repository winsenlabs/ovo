import { expect, it } from 'vitest';
import { MemoryRecordingRepository } from '../src/memory-repository.ts';

it('uses the same code-unit order for recording retention pages and cursor comparisons', async () => {
  const repository = new MemoryRecordingRepository();
  const at = '2026-01-01T00:00:00.000Z';
  for (const id of ['a', 'A', 'é', 'z'])
    await repository.create({
      id,
      workspaceId: 'workspace',
      callId: 'call',
      source: 'carrier',
      state: 'available',
      createdAt: at,
      updatedAt: at,
      expiresAt: at,
      codec: 'audio/x-mulaw',
      sampleRate: 8000,
      channels: 2,
      segmentBytes: 160,
    });
  expect((await repository.list('workspace', 'call')).map((item) => item.id)).toEqual([
    'A',
    'a',
    'z',
    'é',
  ]);
  const first = await repository.pageExpired(at, undefined, 2);
  const second = await repository.pageExpired(at, first.nextCursor, 2);
  expect([...first.items, ...second.items].map((item) => item.id)).toEqual(['A', 'a', 'z', 'é']);
});
