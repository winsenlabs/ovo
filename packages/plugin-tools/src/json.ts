import { createHash } from 'node:crypto';

/** Stable JSON is used for operation collision checks and schema release digests. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown): string => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('Only finite JSON numbers are supported');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      if (seen.has(item)) throw new TypeError('Cyclic JSON is not supported');
      seen.add(item);
      const result = `[${item.map(encode).join(',')}]`;
      seen.delete(item);
      return result;
    }
    if (typeof item === 'object') {
      if (seen.has(item)) throw new TypeError('Cyclic JSON is not supported');
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError('Only plain JSON objects are supported');
      seen.add(item);
      const result = `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => `${JSON.stringify(key)}:${encode(child)}`)
        .join(',')}}`;
      seen.delete(item);
      return result;
    }
    throw new TypeError(`Unsupported JSON value: ${typeof item}`);
  };
  return encode(value);
}

export function schemaDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
