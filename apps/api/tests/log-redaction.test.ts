import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { apiLogger, redactUrl } from '../src/log-redaction.ts';

describe('redactUrl', () => {
  it('hides every query value on a path that carries a bearer, and keeps the parameter names', () => {
    expect(redactUrl('/v1/human-queue/context/abc?t=SECRET&x=1')).toBe(
      '/v1/human-queue/context/abc?t=[REDACTED]&x=[REDACTED]',
    );
  });

  it('leaves other urls alone', () => {
    expect(redactUrl('/v1/calls?limit=5')).toBe('/v1/calls?limit=5');
    expect(redactUrl('/v1/human-queue/context/abc')).toBe('/v1/human-queue/context/abc');
  });
});

describe('request log', () => {
  it('never writes a context link’s token, whether the request succeeds or not', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: { ...apiLogger('info'), stream } });
    app.get('/v1/human-queue/context/:id', async () => {
      throw new Error('boom');
    });
    await app.inject({ method: 'GET', url: '/v1/human-queue/context/x?t=SECRETTOKEN1234567890' });
    await app.inject({ method: 'GET', url: '/v1/human-queue/context/y?t=SECRETTOKEN0987654321' });
    await app.close();
    const log = lines.join('');
    expect(log).toContain('/v1/human-queue/context/x?t=[REDACTED]');
    expect(log).not.toContain('SECRETTOKEN');
  });
});
