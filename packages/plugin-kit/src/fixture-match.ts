import type { NetFixtureScript, NetFixtureStep } from '@winsendotai/ovo-contracts';

/** A FixtureNet HTTP reply. `bodyBase64` and `chunks` extend the contract for binary bodies. */
export interface FixtureHttpReply {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  bodyBase64?: string;
  /** Streams the body chunk by chunk (e.g. an odd-byte PCM split or SSE deltas). */
  chunks?: readonly (string | { base64: string })[];
}

type HttpStep = Extract<NetFixtureStep, { expect: 'http' }>;

/** A NetFixtureStep whose HTTP reply may use the binary extensions of `FixtureHttpReply`. */
export type FixtureStep =
  Exclude<NetFixtureStep, HttpStep> | (Omit<HttpStep, 'reply'> & { reply: FixtureHttpReply });

/** A NetFixtureScript over `FixtureStep`s; every NetFixtureScript is one. */
export interface FixtureScript extends Omit<NetFixtureScript, 'steps'> {
  steps: FixtureStep[];
}

/** The unit of a FixtureNet replay. It carries `script.source` into mismatch reports. */
export class FixtureMismatchError extends Error {
  constructor(
    readonly host: string,
    readonly expected: string,
    readonly actual: string,
    readonly source?: string,
  ) {
    super(
      `FixtureNet mismatch on ${host}: expected ${expected}; got ${actual}${source ? ` (script ${source})` : ''}`,
    );
    this.name = 'FixtureMismatchError';
  }
}

export function describeStep(step: FixtureStep | undefined, index?: number): string {
  const at = index === undefined ? '' : `step #${index} `;
  if (!step) return `${at}end of script`;
  if ('expect' in step) {
    if (step.expect === 'http') return `${at}http ${step.method} ${String(step.url)}`;
    if (step.expect === 'ws-open') return `${at}ws-open ${String(step.url)}`;
    const where = step.where ? ` where ${JSON.stringify(step.where)}` : '';
    return `${at}ws-send ${step.match}${where}${step.repeat ? ' (repeat until-next)' : ''}`;
  }
  if ('send' in step) return `${at}server send`;
  if ('close' in step) return `${at}server close ${step.close.code}`;
  return `${at}delay ${step.delayMs} ms`;
}

function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Every `where` entry (dotted paths allowed) equals, or for a RegExp matches, the parsed value. */
export function matchesWhere(value: unknown, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, expected]) => {
    const actual = valueAt(value, path);
    if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
    return deepEqual(actual, expected);
  });
}

export function matchesText(expected: string | RegExp, actual: string): boolean {
  if (expected instanceof RegExp) return expected.test(actual);
  if (expected === actual) return true;
  try {
    return new URL(expected).href === new URL(actual).href;
  } catch {
    return false;
  }
}

/** Parses a form body; a repeated key becomes an array. */
export function parseForm(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(text)) {
    const current = out[key];
    out[key] =
      current === undefined ? value : [...(Array.isArray(current) ? current : [current]), value];
  }
  return out;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Body check for an `http` step: 'json' and 'form' must parse; `where` applies to the parsed body. */
export function matchesBody(step: Extract<FixtureStep, { expect: 'http' }>, body: string): boolean {
  if (step.body === 'json') {
    const parsed = parseJson(body);
    return parsed.ok && matchesWhere(parsed.value, step.where);
  }
  if (step.body === 'form') return matchesWhere(parseForm(body), step.where);
  if (!step.where) return true;
  const parsed = parseJson(body);
  return matchesWhere(parsed.ok ? parsed.value : parseForm(body), step.where);
}

export function matchesFrame(
  step: Extract<NetFixtureStep, { expect: 'ws-send' }>,
  data: string | Uint8Array,
): boolean {
  if (step.match === 'binary') return typeof data !== 'string';
  if (step.match === 'any') return true;
  if (typeof data !== 'string') return false;
  const parsed = parseJson(data);
  return parsed.ok && matchesWhere(parsed.value, step.where);
}

export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

/** Script-owned hosts may be written with or without a port. */
export function hostMatches(script: FixtureScript, url: URL): boolean {
  const host = script.host.toLowerCase();
  return host.includes(':') ? host === url.host.toLowerCase() : host === url.hostname.toLowerCase();
}

export function describeFrame(data: string | Uint8Array): string {
  if (typeof data !== 'string') return `binary frame (${data.byteLength} bytes)`;
  return `text frame ${data.length > 160 ? `${data.slice(0, 157)}...` : data}`;
}
