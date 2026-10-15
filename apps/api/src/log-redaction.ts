import type { FastifyRequest } from 'fastify';

/** Paths whose query string carries a bearer: a third party's context link (`?t=`), never logged. */
const BEARER_QUERY_PREFIXES = ['/v1/human-queue/context/'];

/** `url` with every query value replaced on a path that carries a bearer in its query string. */
export function redactUrl(url: string): string {
  const query = url.indexOf('?');
  if (query < 0) return url;
  const path = url.slice(0, query);
  if (!BEARER_QUERY_PREFIXES.some((prefix) => path.startsWith(prefix))) return url;
  const pairs = url
    .slice(query + 1)
    .split('&')
    .map((pair) => `${pair.split('=')[0]}=[REDACTED]`);
  return `${path}?${pairs.join('&')}`;
}

/** Fastify's own request log fields, with the url redacted. */
export function serializeRequest(request: FastifyRequest) {
  const version = request.headers['accept-version'];
  return {
    method: request.method,
    url: redactUrl(request.url),
    version: Array.isArray(version) ? version[0] : version,
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

/** The API's request logger: secrets in headers and bodies are censored, bearer urls redacted. */
export function apiLogger<Level extends string>(level: Level) {
  return {
    level,
    serializers: { req: serializeRequest },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.token',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'req.body.value',
      ],
      censor: '[REDACTED]',
    },
  };
}
