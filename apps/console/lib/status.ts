// Single status-tone mapping (design brief §1 "Status language"). Every screen must badge a
// value through this map instead of inventing its own colour: `running`/`queued` are info,
// `cancelled` is neutral, `failed` is danger, never the other way around.
export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

const TONE_VALUES: Record<Tone, readonly string[]> = {
  ok: [
    'completed',
    'succeeded',
    'success',
    'active',
    'enabled',
    'ready',
    'healthy',
    'imported',
    'covered',
    'within',
    'passed',
    'available',
    'confirmed',
    'resolved',
  ],
  info: ['running', 'in_progress', 'dialing', 'queued', 'starting', 'scheduled', 'pending'],
  warn: [
    'partial',
    'degraded',
    'paused',
    'provisional',
    'overdue',
    'update_available',
    'flagged',
    'warn',
    'reconciling',
    'acknowledged',
  ],
  danger: [
    'failed',
    'error',
    'timeout',
    'timed_out',
    'over_limit',
    'blocked',
    'suspended',
    'stop',
    'revoked',
    'rejected',
  ],
  neutral: ['cancelled', 'disabled', 'retired', 'not_imported', 'closed', 'draft', 'unknown'],
};

const LOOKUP = new Map<string, Tone>();
for (const [tone, values] of Object.entries(TONE_VALUES) as [Tone, readonly string[]][])
  for (const value of values) LOOKUP.set(value, tone);

/** Normalise `In Progress` / `IN-PROGRESS` / `in progress` to the `in_progress` lookup key. */
function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Tone for a raw status/enum value. Unknown values are neutral, never a silent "ok". */
export function statusTone(value: string | null | undefined): Tone {
  if (!value) return 'neutral';
  return LOOKUP.get(normalise(value)) ?? 'neutral';
}

/** `in_progress` -> "In progress"; `promised_to_pay` -> "Promised to pay". Keeps acronyms as-is. */
export function humaniseEnum(value: string | null | undefined): string {
  if (!value) return 'Unknown';
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // Dotted event types (`call.started`, from the timeline/event stream) humanise the same way
    // as snake_case and kebab-case.
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return 'Unknown';
  return words
    .map((word, index) => {
      const isAcronym = word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word);
      if (isAcronym) return word;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** `camelCaseField` / `snake_case_field` -> "Camel case field", for a last-resort label. */
export function humaniseKey(key: string): string {
  return humaniseEnum(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2'));
}
