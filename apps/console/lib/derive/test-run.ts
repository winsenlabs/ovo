// Pure helpers for the Test tab's fixture-run stream. Split out of `features/test-console.tsx`
// to stay under the module-size gate.
export type FixtureEvent = {
  eventId?: string;
  kind?: string;
  type?: string;
  stage?: string;
  text?: string;
  phase?: string;
  speaker?: string;
  costPaise?: string;
  atMs?: number;
  payload?: Record<string, unknown>;
};

export function field(event: FixtureEvent, key: keyof FixtureEvent): string | undefined {
  const value = event[key] ?? event.payload?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function transcriptPhase(event: FixtureEvent) {
  const phase = field(event, 'phase') ?? event.kind ?? event.type ?? '';
  return /played/i.test(phase)
    ? 'played'
    : /generated/i.test(phase)
      ? 'generated'
      : /interim/i.test(phase)
        ? 'interim'
        : 'final';
}

export const STAGE_ORDER = ['accepted', 'media', 'stt', 'decision', 'tts', 'played'] as const;
