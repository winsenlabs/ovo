import type { JsonSchema } from '@winsendotai/ovo-contracts';

const sensitive = /password|secret|token|authorization|api.?key/i;
const currencies: Record<string, string> = {
  INR: 'rupees',
  USD: 'dollars',
  EUR: 'euros',
  GBP: 'pounds',
};

/** Schema-ordered speech keeps the confirmed values legible without exposing credentials. */
export function speakArguments(input: unknown, schema: JsonSchema, language: string): string {
  const numbers = new Intl.NumberFormat(language);
  const speak = (value: unknown, shape: JsonSchema = {}, depth = 0): string => {
    if (depth > 10) throw new Error('Action details are too large for voice confirmation');
    if (value === null || value === undefined) return 'none';
    if (typeof value === 'number') {
      const format =
        typeof shape.format === 'string' ? shape.format.replace(/^currency[:-]/i, '') : '';
      const hint = String(
        shape['x-unit'] ?? shape.currency ?? (currencies[format.toUpperCase()] ? format : ''),
      ).trim();
      const unit = currencies[hint.toUpperCase()] ?? hint;
      return `${numbers.format(value)}${unit ? ` ${unit}` : ''}`;
    }
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    if (Array.isArray(value))
      return value.map((item) => speak(item, objectSchema(shape.items), depth + 1)).join(', ');
    if (typeof value === 'object') {
      const properties = objectSchema(shape.properties);
      const record = value as Record<string, unknown>;
      const keys = [...new Set([...Object.keys(properties), ...Object.keys(record)])];
      return keys
        .filter((key) => Object.hasOwn(record, key))
        .map((key) => {
          const child = objectSchema(properties[key]);
          const label =
            typeof child.title === 'string'
              ? child.title
              : key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
          return `${label}: ${sensitive.test(key) ? '[redacted]' : speak(record[key], child, depth + 1)}`;
        })
        .join(', ');
    }
    return String(value);
  };
  const details = speak(input, schema);
  if (details.length > 800) throw new Error('Action details are too large for voice confirmation');
  return details;
}

function objectSchema(value: unknown): JsonSchema {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonSchema) : {};
}
