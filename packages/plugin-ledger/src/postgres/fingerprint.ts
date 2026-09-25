import { createHash } from 'node:crypto';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(row[key])}`)
    .join(',')}}`;
}
