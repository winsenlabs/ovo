export function parseInboundRouteVariables(value: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Route variables must be valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Route variables must be a JSON object.');
  }
  const entries = Object.entries(parsed);
  if (entries.some(([, entry]) => typeof entry !== 'string')) {
    throw new Error('Every route variable value must be a string.');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

export function inboundRoutePath(phoneNumber: string): string {
  return `/operations/inbound/routes/${encodeURIComponent(phoneNumber)}`;
}
