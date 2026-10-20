import { publishPoint, r4Setup, scriptedSimulator } from './routing-sim-fixtures.ts';

export const NOW = Date.parse('2026-10-20T10:00:00.000Z');
export const editor = { 'x-role': 'editor' };

export const speech = (text: string) => ({ kind: 'speech' as const, text });
export async function published(options: Parameters<typeof r4Setup>[0] = {}) {
  const simulator = scriptedSimulator();
  const built = await r4Setup({ simulator, clock: () => NOW, ...options });
  const made = await publishPoint(built.call);
  const run = (body: unknown, headers: Record<string, string> = {}) =>
    built.call('POST', '/v1/routing/simulate', body, headers);
  return { ...built, ...made, simulator, run };
}
