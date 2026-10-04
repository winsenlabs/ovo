import { createHash } from 'node:crypto';
const sensitive =
  /^(authorization|cookie|password|secret|token|credential|api.?key|phone|email|transcript|audio|input|result|context|text|utterance)(?:$|[_-])/i;
/** Conservative boundary redaction. Raw transcript/artifacts belong in separately authorized stores. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string')
    return value.length > 500
      ? '[long-value]'
      : value
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
          .replace(/\+?\d[\d ().-]{8,}\d/g, '[number]');
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, val]) => [key, sensitive.test(key) ? '[redacted]' : redact(val, depth + 1)]),
    );
  return value;
}
export function evidenceDigest(events: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}
