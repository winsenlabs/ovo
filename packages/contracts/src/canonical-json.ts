/** Code-unit comparison for tie-break sorts. Never `localeCompare`, whose order depends on ICU data (#19). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Stable JSON: object keys sorted by UTF-16 code unit, everything else exactly as `JSON.stringify`
 * (`toJSON`, boxed primitives, dropped `undefined`/function/symbol members, `null` in arrays,
 * non-finite numbers as `null`, a `TypeError` for cycles and bigint). Like `JSON.stringify`, a
 * top-level value that JSON cannot represent yields `undefined` at run time.
 */
export function canonicalJson(value: unknown): string {
  const stack: object[] = [];
  const encode = (key: string, holder: unknown): string | undefined => {
    let item = holder;
    if (item !== null && (typeof item === 'object' || typeof item === 'bigint')) {
      const toJSON = (item as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === 'function') item = toJSON.call(item, key);
    }
    if (item instanceof Number || item instanceof String || item instanceof Boolean)
      item = item.valueOf();
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string':
      case 'boolean':
        return JSON.stringify(item);
      case 'number':
        return Number.isFinite(item) ? JSON.stringify(item) : 'null';
      case 'bigint':
        throw new TypeError('Do not know how to serialize a BigInt');
      case 'undefined':
      case 'function':
      case 'symbol':
        return undefined;
    }
    const object = item as object;
    if (stack.includes(object)) throw new TypeError('Converting circular structure to JSON');
    stack.push(object);
    let result: string;
    if (Array.isArray(object)) {
      result = `[${object.map((child, index) => encode(String(index), child) ?? 'null').join(',')}]`;
    } else {
      const members: string[] = [];
      for (const name of Object.keys(object).sort(compareCodeUnits)) {
        const encoded = encode(name, (object as Record<string, unknown>)[name]);
        if (encoded !== undefined) members.push(`${JSON.stringify(name)}:${encoded}`);
      }
      result = `{${members.join(',')}}`;
    }
    stack.pop();
    return result;
  };
  return encode('', value) as string;
}
