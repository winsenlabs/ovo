/** RFC 3261 §7.3.3 compact header forms, expanded at parse time. */
const COMPACT: Readonly<Record<string, string>> = {
  i: 'call-id',
  m: 'contact',
  e: 'content-encoding',
  l: 'content-length',
  c: 'content-type',
  f: 'from',
  s: 'subject',
  k: 'supported',
  t: 'to',
  v: 'via',
  o: 'event',
  r: 'refer-to',
  x: 'session-expires',
  u: 'allow-events',
};

/** Display names used when serialising; anything else is written as received. */
const CANONICAL: Readonly<Record<string, string>> = {
  'call-id': 'Call-ID',
  cseq: 'CSeq',
  via: 'Via',
  'www-authenticate': 'WWW-Authenticate',
  'min-se': 'Min-SE',
  'p-asserted-identity': 'P-Asserted-Identity',
  'record-route': 'Record-Route',
  'retry-after': 'Retry-After',
};

export function headerKey(name: string): string {
  const lower = name.trim().toLowerCase();
  return COMPACT[lower] ?? lower;
}

export function headerDisplay(key: string): string {
  return (
    CANONICAL[key] ??
    key.replace(/(^|-)([a-z])/g, (_m, dash: string, c: string) => dash + c.toUpperCase())
  );
}

/** Headers in wire order; lookups are by lowercase full name. */
export class SipHeaders {
  private readonly list: [string, string][] = [];

  constructor(entries: Iterable<readonly [string, string]> = []) {
    for (const [name, value] of entries) this.append(name, value);
  }

  append(name: string, value: string): this {
    this.list.push([headerKey(name), value.trim()]);
    return this;
  }

  set(name: string, value: string): this {
    this.delete(name);
    return this.append(name, value);
  }

  /** Inserts before every existing header of the same name (Via and Route on the way out). */
  prepend(name: string, value: string): this {
    const key = headerKey(name);
    const index = this.list.findIndex(([k]) => k === key);
    this.list.splice(index < 0 ? this.list.length : index, 0, [key, value.trim()]);
    return this;
  }

  delete(name: string): this {
    const key = headerKey(name);
    for (let i = this.list.length - 1; i >= 0; i -= 1)
      if (this.list[i]![0] === key) this.list.splice(i, 1);
    return this;
  }

  get(name: string): string | undefined {
    const key = headerKey(name);
    return this.list.find(([k]) => k === key)?.[1];
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  /** Every value as received, unsplit (auth challenges carry commas inside one value). */
  values(name: string): string[] {
    const key = headerKey(name);
    return this.list.filter(([k]) => k === key).map(([, value]) => value);
  }

  /** Every value, with comma-joined lists split (outside quotes and angle brackets). */
  getAll(name: string): string[] {
    const key = headerKey(name);
    return this.list.filter(([k]) => k === key).flatMap(([, value]) => splitList(value));
  }

  get size(): number {
    return this.list.length;
  }

  entries(): readonly (readonly [string, string])[] {
    return this.list;
  }

  clone(): SipHeaders {
    return new SipHeaders(this.list);
  }
}

/** Splits `a, "b, c" <sip:d,e>, f` on top-level commas. */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '\\' && quoted) i += 1;
    else if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '<') depth += 1;
    else if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    else if (!quoted && depth === 0 && ch === ',') {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

export interface SipRequest {
  kind: 'request';
  method: string;
  uri: string;
  headers: SipHeaders;
  body: Uint8Array;
}

export interface SipResponse {
  kind: 'response';
  status: number;
  reason: string;
  headers: SipHeaders;
  body: Uint8Array;
}

export type SipMessage = SipRequest | SipResponse;

/** RFC 3261 §21 reason phrases for every status this gateway sends. */
export const REASONS: Readonly<Record<number, string>> = {
  100: 'Trying',
  180: 'Ringing',
  183: 'Session Progress',
  200: 'OK',
  202: 'Accepted',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  415: 'Unsupported Media Type',
  420: 'Bad Extension',
  422: 'Session Interval Too Small',
  480: 'Temporarily Unavailable',
  481: 'Call/Transaction Does Not Exist',
  482: 'Loop Detected',
  486: 'Busy Here',
  487: 'Request Terminated',
  488: 'Not Acceptable Here',
  491: 'Request Pending',
  500: 'Server Internal Error',
  503: 'Service Unavailable',
  603: 'Decline',
};

/** NOTIFY is accepted only as the progress of a REFER we sent (`call/refer.ts`). */
export const ALLOWED_METHODS = [
  'INVITE',
  'ACK',
  'BYE',
  'CANCEL',
  'OPTIONS',
  'UPDATE',
  'INFO',
  'NOTIFY',
];

/** `CSeq: 4711 INVITE` */
export function parseCSeq(value: string | undefined): { seq: number; method: string } | undefined {
  const match = /^(\d{1,10})\s+([A-Za-z]+)$/.exec(value?.trim() ?? '');
  if (!match) return undefined;
  const seq = Number(match[1]);
  return seq < 2 ** 31 ? { seq, method: match[2]!.toUpperCase() } : undefined;
}
