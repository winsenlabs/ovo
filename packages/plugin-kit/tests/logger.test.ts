import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  errorFields,
  logFailure,
  parseLogLevel,
  redactLogText,
} from '../src/index.ts';

function capture(level?: string) {
  const lines: { line: Record<string, unknown>; level: string }[] = [];
  const logger = createLogger(
    { service: 'test' },
    {
      level,
      now: () => new Date('2026-10-05T00:00:00.000Z'),
      sink: (line, at) => lines.push({ line: JSON.parse(line), level: at }),
    },
  );
  return { logger, lines };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('JSON-lines logger', () => {
  it('writes one object per line with ts, level, event, context and fields', () => {
    const { logger, lines } = capture();
    logger.child({ sessionId: 's-1' }).info('carrier_session_closed', { reason: 'done' });
    expect(lines).toEqual([
      {
        level: 'info',
        line: {
          ts: '2026-10-05T00:00:00.000Z',
          level: 'info',
          event: 'carrier_session_closed',
          service: 'test',
          sessionId: 's-1',
          reason: 'done',
        },
      },
    ]);
  });

  it('keeps ts, level and event authoritative over same-named fields', () => {
    const { logger, lines } = capture();
    logger.warn('real', { event: 'forged', level: 'debug' });
    expect(lines[0]?.line).toMatchObject({ event: 'real', level: 'warn' });
  });

  it('defaults to info and reads OVO_LOG_LEVEL', () => {
    const quiet = capture();
    quiet.logger.debug('hidden');
    quiet.logger.info('shown');
    expect(quiet.lines.map((entry) => entry.line.event)).toEqual(['shown']);

    vi.stubEnv('OVO_LOG_LEVEL', 'debug');
    const verbose = capture();
    verbose.logger.debug('visible');
    expect(verbose.lines).toHaveLength(1);

    vi.stubEnv('OVO_LOG_LEVEL', 'warn');
    const strict = capture();
    strict.logger.info('dropped');
    strict.logger.error('kept');
    expect(strict.lines.map((entry) => entry.line.event)).toEqual(['kept']);
  });

  it('treats an unknown level as info', () => {
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel(' WARN ')).toBe('warn');
    expect(parseLogLevel(undefined)).toBe('info');
  });

  it('redacts credential keys, bearer/basic values, URL secrets and phone numbers', () => {
    const { logger, lines } = capture();
    logger.warn('upgrade_rejected', {
      authorization: 'Bearer abc.def',
      routeToken: 'rt-secret',
      rt: 'rt-secret',
      t: 'url-secret',
      authToken: 'twilio-token',
      inputTokens: 42,
      headers: { 'x-twilio-signature': 'sig', cookie: 'c' },
      url: 'wss://media.example/carriers/twilio/env/media?sid=s-1&rt=rt-secret&t=url-secret',
      database: 'postgres://ovo:hunter2@db:5432/ovo',
      detail: 'worker said Bearer abc.def and Basic dXNlcjpwYXNz to +919876543210',
    });
    const text = JSON.stringify(lines[0]?.line);
    for (const secret of ['abc.def', 'rt-secret', 'url-secret', 'twilio-token', 'hunter2'])
      expect(text).not.toContain(secret);
    expect(text).not.toContain('dXNlcjpwYXNz');
    expect(text).not.toContain('9876543210');
    expect(lines[0]?.line).toMatchObject({
      inputTokens: 42,
      url: 'wss://media.example/carriers/twilio/env/media?sid=s-1&rt=[redacted]&t=[redacted]',
      headers: { 'x-twilio-signature': '[redacted]', cookie: '[redacted]' },
    });
  });

  it('serializes errors as reason, class and cause without the stack', () => {
    const failure = new TypeError('handshake failed', { cause: new Error('401 from provider') });
    expect(errorFields(failure)).toEqual({
      error: 'handshake failed',
      errorName: 'TypeError',
      cause: '401 from provider',
    });
    expect(errorFields('plain')).toEqual({ error: 'plain' });
    const { logger, lines } = capture();
    logger.error('session_open_failed', { failure });
    expect(lines[0]?.line.failure).toEqual({
      error: 'handshake failed',
      errorName: 'TypeError',
      cause: '401 from provider',
    });
  });

  it('keeps the error code and the reasons inside an empty AggregateError', () => {
    const v4 = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
      code: 'ECONNREFUSED',
    });
    expect(errorFields(v4)).toEqual({
      error: 'connect ECONNREFUSED 127.0.0.1:1',
      errorName: 'Error',
      code: 'ECONNREFUSED',
    });
    // What ws reports when happy-eyeballs fails every address: no message of its own.
    const both = Object.assign(new AggregateError([v4, new Error('connect ECONNREFUSED ::1:1')]), {
      code: 'ECONNREFUSED',
    });
    expect(errorFields(both)).toEqual({
      error: 'connect ECONNREFUSED 127.0.0.1:1; connect ECONNREFUSED ::1:1',
      errorName: 'AggregateError',
      code: 'ECONNREFUSED',
    });
  });

  it('never throws from a broken sink or unserializable fields', () => {
    const broken = createLogger(
      {},
      {
        sink: () => {
          throw new Error('closed stream');
        },
      },
    );
    expect(() => broken.error('event')).not.toThrow();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const { logger, lines } = capture();
    expect(() => logger.info('cyclic', { cyclic })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('routes warn and error to stderr and the rest to stdout by default', () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logger = createLogger({}, { level: 'debug' });
    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');
    expect(out).toHaveBeenCalledTimes(2);
    expect(err).toHaveBeenCalledTimes(2);
  });

  it('logs a best-effort failure at warn with its reason and IDs', async () => {
    const { logger, lines } = capture();
    await Promise.reject(new Error('pool closed')).catch(
      logFailure(logger, 'cleanup_failed', { jobId: 'job-1' }),
    );
    expect(lines[0]).toMatchObject({
      level: 'warn',
      line: { event: 'cleanup_failed', jobId: 'job-1', error: 'pool closed', errorName: 'Error' },
    });
  });

  it('scrubs persisted reason text the same way', () => {
    expect(redactLogText('auth failed for Bearer sk-live-123')).toBe(
      'auth failed for Bearer [redacted]',
    );
  });
});
