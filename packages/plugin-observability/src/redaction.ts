import { createHash } from 'node:crypto';
const sensitive =
  /^(authorization|cookie|password|secret|token|credential|api.?key|phone|email|transcript|audio|input|result|context|text|utterance)(?:$|[_-])/i;
// The logger's credential rules (plugin-kit `isSecretField`/`scrubCredentials`); one corpus pins
// both (scripts/tests/credential-redaction.test.ts), so a shape added to one fails the other.
const credentialKey =
  /(?:authorization|cookie|password|passphrase|secret|signature|credential|token|api[_-]?key|master[_-]?key|private[_-]?key|secret[_-]?key|access[_-]?key|access[_-]?key[_-]?id)$|^(?:rt|t|sig)$/i;
const credentialQuery =
  /([?&](?:t|rt|sig|token|routeToken|signature|access_token|refresh_token|id_token|api_key|api-key|apikey|xi_api_key|xi-api-key|key|secret|client_secret|secretKey|secret_key|accessKey|access_key|password|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&#\s"']*/gi;
const scrub = (value: string) =>
  value
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@')
    .replace(credentialQuery, '$1[redacted]');
/** Conservative boundary redaction. Raw transcript/artifacts belong in separately authorized stores. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string')
    return value.length > 500
      ? '[long-value]'
      : scrub(value)
          .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
          .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
          .replace(/\+?\d[\d ().-]{8,}\d/g, '[number]');
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, val]) => [
          key,
          sensitive.test(key) || credentialKey.test(key) ? '[redacted]' : redact(val, depth + 1),
        ]),
    );
  return value;
}
export function evidenceDigest(events: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(events)).digest('hex');
}
