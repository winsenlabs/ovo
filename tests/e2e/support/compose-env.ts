import { readFileSync } from 'node:fs';

export const COMPOSE_SOURCE = readFileSync(
  new URL('../../../infra/compose/compose.yaml', import.meta.url),
  'utf8',
);

interface Mapping {
  entries: Map<string, string | Mapping>;
  merges: string[];
}

function unquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value) as string;
  return value;
}

/**
 * The raw `environment` of every Compose service, with `&anchor` / `<<: *alias` merges applied.
 * compose.yaml only uses block mappings for environments, so this reads that subset of YAML;
 * sequences and flow collections (ports, healthchecks) are skipped.
 */
export function serviceEnvironments(source: string): Record<string, Record<string, string>> {
  const anchors = new Map<string, Mapping>();
  const root: Mapping = { entries: new Map(), merges: [] };
  const stack: { indent: number; node: Mapping }[] = [{ indent: -1, node: root }];
  for (const line of source.split('\n')) {
    const match = /^( *)([A-Za-z0-9_][\w.-]*|<<):(?: +(.*))?$/.exec(line);
    if (!match) continue;
    const indent = match[1]!.length;
    const key = match[2]!;
    const value = (match[3] ?? '').trim();
    while (stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.node;
    if (key === '<<') {
      parent.merges.push(value.replace(/^\*/, ''));
    } else if (value === '' || /^&[\w-]+$/.test(value)) {
      const node: Mapping = { entries: new Map(), merges: [] };
      parent.entries.set(key, node);
      if (value) anchors.set(value.slice(1), node);
      stack.push({ indent, node });
    } else {
      parent.entries.set(key, unquote(value));
    }
  }
  const flatten = (node: Mapping): Record<string, string> => {
    const merged: Record<string, string> = {};
    for (const alias of node.merges) {
      const anchored = anchors.get(alias);
      if (!anchored) throw new Error(`Unknown Compose anchor ${alias}`);
      Object.assign(merged, flatten(anchored));
    }
    for (const [key, value] of node.entries) if (typeof value === 'string') merged[key] = value;
    return merged;
  };
  const services = root.entries.get('services');
  if (!services || typeof services === 'string') throw new Error('compose.yaml has no services');
  const result: Record<string, Record<string, string>> = {};
  for (const [name, service] of services.entries) {
    if (typeof service === 'string') continue;
    const environment = service.entries.get('environment');
    result[name] = environment && typeof environment !== 'string' ? flatten(environment) : {};
  }
  return result;
}

/** Compose variable interpolation: `${X}`, `${X:-d}`, `${X-d}` and `${X:?message}`. */
export function interpolate(value: string, variables: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?])([^}]*))?\}/g,
    (_whole, name: string, colon: string, operator: string | undefined, argument: string) => {
      const current = variables[name];
      const missing = current === undefined || (colon === ':' && current === '');
      if (!operator || !missing) return current ?? '';
      if (operator === '?') throw new Error(`Compose requires ${name}: ${argument}`);
      return argument;
    },
  );
}

/** The environment Compose would hand one service, given the deployment's `.env` values. */
export function renderServiceEnv(
  service: string,
  variables: Readonly<Record<string, string>>,
  source = COMPOSE_SOURCE,
): Record<string, string> {
  const raw = serviceEnvironments(source)[service];
  if (!raw) throw new Error(`Missing Compose service ${service}`);
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, interpolate(value, variables)]),
  );
}
