/**
 * Credential redaction shared by the logger and anything else that persists free text. The same
 * credential corpus pins plugin-observability's boundary redaction (scripts/tests).
 */

// Keys whose values are credentials whatever they hold. `rt`/`t` are the carrier route-token and
// URL-secret query names; count fields such as `inputTokens` deliberately do not match.
const SECRET_KEY =
  /(?:authorization|cookie|password|passphrase|secret|signature|credential|token|api[_-]?key|master[_-]?key|private[_-]?key|secret[_-]?key|access[_-]?key|access[_-]?key[_-]?id)$/i;
const SECRET_SHORT_KEYS = new Set(['rt', 't', 'sig']);

/** Query parameters that carry a credential in vendor URLs (`?xi_api_key=`, `?api-key=` …). */
const SECRET_QUERY =
  /([?&](?:t|rt|sig|token|routeToken|signature|access_token|refresh_token|id_token|api_key|api-key|apikey|xi_api_key|xi-api-key|key|secret|client_secret|secretKey|secret_key|accessKey|access_key|password|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&#\s"']*/gi;

export function isSecretField(key: string): boolean {
  return SECRET_KEY.test(key) || SECRET_SHORT_KEYS.has(key);
}

/**
 * Scrubs bearer/basic/token credentials, URL userinfo (passwords may contain '@'; everything up to
 * the last '@' before the host is userinfo) and secret query parameters.
 */
export function scrubCredentials(text: string): string {
  return (
    text
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
      // `Authorization: Token <key>`; a credential-shaped value only, so prose such as
      // "token budget" keeps its words.
      .replace(/\b(Token)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, '$1[redacted]@')
      .replace(SECRET_QUERY, '$1[redacted]')
  );
}
