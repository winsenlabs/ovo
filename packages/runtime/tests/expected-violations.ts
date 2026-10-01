import { getViolationSink, setViolationSink } from '../src/enforcement.ts';
import type { PluginViolation } from '../src/index.ts';

type ViolationKey = Pick<PluginViolation, 'pluginId' | 'kind' | 'key'>;

/** Keep deliberate negative assertions out of the repository-wide violation baseline. */
export async function withExpectedViolations<T>(
  expected: readonly ViolationKey[],
  run: () => T | Promise<T>,
): Promise<T> {
  const previous = getViolationSink();
  const seen: ViolationKey[] = [];
  setViolationSink((violation) => {
    const entry = {
      pluginId: violation.pluginId,
      kind: violation.kind,
      key: violation.key,
    };
    const wanted = expected[seen.length];
    seen.push(entry);
    if (
      !wanted ||
      wanted.pluginId !== entry.pluginId ||
      wanted.kind !== entry.kind ||
      wanted.key !== entry.key
    )
      previous?.(violation);
  });
  try {
    const result = await run();
    if (
      seen.length !== expected.length ||
      seen.some(
        (entry, index) =>
          entry.pluginId !== expected[index]?.pluginId ||
          entry.kind !== expected[index]?.kind ||
          entry.key !== expected[index]?.key,
      )
    )
      throw new Error(
        `Expected deliberate plugin violations ${JSON.stringify(expected)}; got ${JSON.stringify(seen)}`,
      );
    return result;
  } finally {
    setViolationSink(previous);
  }
}
