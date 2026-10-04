import { expect, it } from 'vitest';
import config from '../next.config.ts';

it('keeps loopback development origins available alongside preview origins', () => {
  expect(config.allowedDevOrigins).toContain('localhost');
  expect(config.allowedDevOrigins).toContain('127.0.0.1');
  for (const origin of process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(',') ?? []) {
    if (origin.trim()) expect(config.allowedDevOrigins).toContain(origin.trim());
  }
  expect(config.allowedDevOrigins).not.toContain('*');
});
