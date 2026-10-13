/** URI, name-addr and Via parsing for the narrow trunk profile (RFC 3261 §19, §20). */

export type Params = Record<string, string | true>;

export function parseParams(text: string): Params {
  const params: Params = {};
  for (const part of text.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const name = (eq < 0 ? trimmed : trimmed.slice(0, eq)).trim().toLowerCase();
    if (!name) continue;
    params[name] = eq < 0 ? true : unquote(trimmed.slice(eq + 1).trim());
  }
  return params;
}

export function formatParams(params: Params): string {
  return Object.entries(params)
    .map(([name, value]) => (value === true ? `;${name}` : `;${name}=${value}`))
    .join('');
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, '$1')
    : value;
}

export interface SipUri {
  scheme: 'sip' | 'sips' | 'tel';
  user?: string;
  host: string;
  port?: number;
  params: Params;
}

export function parseUri(text: string): SipUri | undefined {
  const match = /^(sips?|tel):([^?]*)/i.exec(text.trim());
  if (!match) return undefined;
  const scheme = match[1]!.toLowerCase() as SipUri['scheme'];
  const [main = '', ...rest] = match[2]!.split(';');
  const params = parseParams(rest.join(';'));
  if (scheme === 'tel') return main ? { scheme, user: main, host: '', params } : undefined;
  const at = main.lastIndexOf('@');
  const user = at < 0 ? undefined : main.slice(0, at).split(':')[0];
  const hostPort = at < 0 ? main : main.slice(at + 1);
  const hp = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(hostPort);
  if (!hp) return undefined;
  const port = hp[2] === undefined ? undefined : Number(hp[2]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  let decoded: string | undefined;
  try {
    decoded = user ? decodeURIComponent(user) : undefined;
  } catch {
    return undefined;
  }
  return {
    scheme,
    ...(decoded ? { user: decoded } : {}),
    host: hp[1]!.toLowerCase(),
    ...(port ? { port } : {}),
    params,
  };
}

export function formatUri(uri: SipUri): string {
  if (uri.scheme === 'tel') return `tel:${uri.user ?? ''}${formatParams(uri.params)}`;
  const user = uri.user ? `${uri.user}@` : '';
  return `${uri.scheme}:${user}${uri.host}${uri.port ? `:${uri.port}` : ''}${formatParams(uri.params)}`;
}

export interface NameAddr {
  display?: string;
  uri: string;
  params: Params;
}

/** `"Display" <uri>;params` or `uri;params` (header params, RFC 3261 §20.10). */
export function parseNameAddr(text: string): NameAddr | undefined {
  const value = text.trim();
  const open = value.indexOf('<');
  if (open >= 0) {
    const close = value.indexOf('>', open);
    if (close < 0) return undefined;
    const display = value.slice(0, open).trim();
    return {
      ...(display ? { display: unquote(display) } : {}),
      uri: value.slice(open + 1, close).trim(),
      params: parseParams(value.slice(close + 1)),
    };
  }
  const semi = value.indexOf(';');
  const uri = (semi < 0 ? value : value.slice(0, semi)).trim();
  return uri ? { uri, params: parseParams(semi < 0 ? '' : value.slice(semi)) } : undefined;
}

export function formatNameAddr(addr: NameAddr): string {
  const display = addr.display ? `"${addr.display.replace(/(["\\])/g, '\\$1')}" ` : '';
  return `${display}<${addr.uri}>${formatParams(addr.params)}`;
}

export interface Via {
  transport: string;
  host: string;
  port?: number;
  params: Params;
}

/** `SIP/2.0/UDP host:port;branch=z9hG4bK…;rport` */
export function parseVia(text: string): Via | undefined {
  const match =
    /^SIP\s*\/\s*2\.0\s*\/\s*([A-Za-z]+)\s+(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?:\s*:\s*(\d{1,5}))?\s*(;.*)?$/.exec(
      text.trim(),
    );
  if (!match) return undefined;
  return {
    transport: match[1]!.toUpperCase(),
    host: match[2]!.toLowerCase(),
    ...(match[3] ? { port: Number(match[3]) } : {}),
    params: parseParams(match[4] ?? ''),
  };
}

export function formatVia(via: Via): string {
  return `SIP/2.0/${via.transport} ${via.host}${via.port ? `:${via.port}` : ''}${formatParams(via.params)}`;
}
