const credentialField =
  /^(?:api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|authorization|cookie|private[_-]?key)$/i;

/** Provider configuration is readable metadata. Credentials belong in secret references. */
export function hasInlineCredential(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (typeof value === 'string' && /^(?:https?|wss?):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return Boolean(url.username || url.password);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasInlineCredential(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => credentialField.test(key) || hasInlineCredential(item, depth + 1),
  );
}
