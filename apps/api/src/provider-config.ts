/**
 * Field names, normalised to snake_case, that only ever hold credentials. Anchored on purpose: a
 * substring match rejected ordinary settings such as `maxOutputTokens`, `tokenizer` and `keyterms`.
 */
const credentialField =
  /^(?:x_)?(?:api_?key|auth_token|access_token|refresh_token|id_token|bearer_token|session_token|token|password|passwd|secret|secret_key|client_secret|secret_access_key|authorization|cookie|private_key|credentials?)$/;

/** Values shaped like a credential, whichever field holds them. */
const credentialValue = [
  /^sk-[\w-]{16,}$/, // `sk-` prefixed secret keys
  /^bearer\s+\S{8,}$/i, // an Authorization header value
  /^eyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]*$/, // a JWT
];

const snakeCase = (key: string) =>
  key
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/[-\s.]+/g, '_')
    .toLowerCase();

function isCredentialString(value: string): boolean {
  const trimmed = value.trim();
  if (/^(?:https?|wss?):\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return Boolean(url.username || url.password);
    } catch {
      return false;
    }
  }
  return credentialValue.some((pattern) => pattern.test(trimmed));
}

/** The path of the first inline credential in provider configuration, without its value. */
export function findInlineCredential(value: unknown, path = '', depth = 0): string | undefined {
  if (depth > 20) return path || '(root)';
  if (typeof value === 'string') return isCredentialString(value) ? path || '(value)' : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
  for (const [key, item] of entries) {
    const at = path ? `${path}.${key}` : key;
    if (!Array.isArray(value) && credentialField.test(snakeCase(key))) return at;
    const found = findInlineCredential(item, at, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Provider configuration is readable metadata. Credentials belong in secret references. */
export function hasInlineCredential(value: unknown): boolean {
  return findInlineCredential(value) !== undefined;
}
