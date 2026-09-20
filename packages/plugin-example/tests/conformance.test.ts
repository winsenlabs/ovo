import { it, expect } from 'vitest';
import { compose } from '@winsendotai/ovo-sdk';
import { reminderBehavior } from '../src/index.ts';
it('loads an external-package capability through only the public SDK', async () => {
  const a = await compose(
    [{ id: 'example.reminder', config: { prefix: 'Hello' } }],
    [reminderBehavior],
  );
  const b = await compose(
    [{ id: 'example.reminder', config: { prefix: 'Reminder for' } }],
    [reminderBehavior],
  );
  const service = a.ctx.get('example.reminder') as { respond(name: string): string };
  expect(service.respond('Anita')).toBe('Hello Anita.');
  expect((b.ctx.get('example.reminder') as typeof service).respond('Anita')).toBe(
    'Reminder for Anita.',
  );
  await a.dispose();
  expect(() => service.respond('Anita')).toThrow('Disposed');
  await b.dispose();
  await expect(
    compose([{ id: 'example.reminder', config: { prefix: 42 } }], [reminderBehavior]),
  ).rejects.toThrow('Invalid config');
});
