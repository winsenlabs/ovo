import { expect, it, vi } from 'vitest';
import { getViolationSink, setViolationSink, type PluginViolation } from '../src/enforcement.ts';
import { withExpectedViolations } from './expected-violations.ts';

const violation = (key: string): PluginViolation => ({
  pluginId: 'test-plugin',
  pluginVersion: '1.0.0',
  kind: 'read-undeclared',
  key,
  mode: 'warn',
  message: key,
});

it('suppresses only exact expected negatives and forwards an unexpected violation', async () => {
  const original = getViolationSink();
  const forwarded = vi.fn();
  setViolationSink(forwarded);
  try {
    await expect(
      withExpectedViolations(
        [{ pluginId: 'test-plugin', kind: 'read-undeclared', key: 'expected' }],
        () => {
          getViolationSink()?.(violation('expected'));
          getViolationSink()?.(violation('unexpected'));
        },
      ),
    ).rejects.toThrow();
    expect(forwarded).toHaveBeenCalledExactlyOnceWith(violation('unexpected'));
  } finally {
    setViolationSink(original);
  }
});
