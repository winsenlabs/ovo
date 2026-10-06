import { describe, expect, it } from 'vitest';
import type { LogFields, Logger } from '@winsendotai/ovo-contracts';
import { compose, type PluginContext } from '../src/index.ts';
import { v1Plugin, v2Plugin } from './support.ts';

/** Records every line with its accumulated child context. */
function recordingLogger(lines: Record<string, unknown>[], context: LogFields = {}): Logger {
  const write = (level: string) => (event: string, fields?: LogFields) =>
    lines.push({ level, event, ...context, ...fields });
  return {
    debug: write('debug'),
    info: write('info'),
    warn: write('warn'),
    error: write('error'),
    child: (extra) => recordingLogger(lines, { ...context, ...extra }),
  };
}

const logging = (id: string, scope: 'process' | 'session' = 'session') =>
  v2Plugin({ id, scope }, (ctx) => {
    (ctx as unknown as PluginContext).logger.info('plugin_started', { detail: id });
  });

// OBS-3 remainder: plugins had no logger, so a provider plugin could only console.log or stay silent.
describe('ctx.logger', () => {
  it('hands each plugin a child of the host logger that names the plugin', async () => {
    const lines: Record<string, unknown>[] = [];
    const composition = await compose([{ id: 'a' }, { id: 'b' }], [logging('a'), logging('b')], {
      logger: recordingLogger(lines, { service: 'worker' }),
    });
    expect(lines).toEqual([
      { level: 'info', event: 'plugin_started', service: 'worker', plugin: 'a', detail: 'a' },
      { level: 'info', event: 'plugin_started', service: 'worker', plugin: 'b', detail: 'b' },
    ]);
    await composition.dispose();
  });

  it('lets a session graph inherit the process logger, or carry its own session ids', async () => {
    const lines: Record<string, unknown>[] = [];
    const parent = await compose(
      [{ id: 'host' }],
      [v1Plugin('host', [], [], () => undefined, { scope: 'process' })],
      {
        scope: 'process',
        logger: recordingLogger(lines, { service: 'worker' }),
      },
    );
    const inherited = await compose([{ id: 's' }], [logging('s')], { scope: 'session', parent });
    const scoped = await compose([{ id: 's' }], [logging('s')], {
      scope: 'session',
      parent,
      logger: parent.logger!.child({ sessionId: 'session-1' }),
    });
    expect(lines).toEqual([
      { level: 'info', event: 'plugin_started', service: 'worker', plugin: 's', detail: 's' },
      {
        level: 'info',
        event: 'plugin_started',
        service: 'worker',
        sessionId: 'session-1',
        plugin: 's',
        detail: 's',
      },
    ]);
    await Promise.all([inherited.dispose(), scoped.dispose(), parent.dispose()]);
  });

  it('is a silent logger, never undefined, when the host gave none', async () => {
    let seen: Logger | undefined;
    const composition = await compose(
      [{ id: 'quiet' }],
      [
        v2Plugin({ id: 'quiet' }, (ctx) => {
          seen = (ctx as unknown as PluginContext).logger;
          seen.child({ x: 1 }).error('nobody_listens');
        }),
      ],
    );
    expect(seen).toBeDefined();
    await composition.dispose();
  });
});
