import type { RoutingIssueCode } from '../routing/issue-codes.ts';
import type { QueueContextPolicy } from './queue.ts';
import {
  CONTEXT_PATHS,
  ContextPath,
  MAPPING_LIMITS,
  MappingRef,
  MappingTemplate,
  RESERVED_WEBHOOK_HEADERS,
  type WebhookSpec,
} from './webhook.ts';

export type MappingIssueCode = Extract<
  RoutingIssueCode,
  'routing_queue_mapping_invalid' | 'routing_queue_mapping_field_disabled'
>;
export interface MappingIssue {
  path: (string | number)[];
  code: MappingIssueCode;
  message: string;
}

type Verdict = 'ok' | 'disabled' | 'unknown';

/**
 * Whether a mapping may read `path` given the queue's context policy: `unknown` for a namespace or
 * leaf the context does not have, `disabled` for one the policy turns off.
 */
export function contextPathVerdict(path: string, policy: QueueContextPolicy): Verdict {
  if (!ContextPath.safeParse(path).success) return 'unknown';
  const [ns, leaf, ...rest] = path.split('.') as [string, string | undefined, ...string[]];
  const leaves = (CONTEXT_PATHS as Record<string, readonly string[]>)[ns]!;
  if (leaf === undefined) return 'unknown';
  if (ns === 'variables') {
    if (rest.length > 0) return 'unknown';
    return policy.variables === 'declared' || policy.variables.includes(leaf) ? 'ok' : 'disabled';
  }
  if (!leaves.includes(leaf)) return 'unknown';
  if (rest.length > (ns === 'route' && leaf === 'context' ? 1 : 0)) return 'unknown';
  const on = (flag: boolean): Verdict => (flag ? 'ok' : 'disabled');
  switch (`${ns}.${leaf}`) {
    case 'caller.number':
      return on(policy.callerId);
    case 'caller.calledNumber':
      return on(policy.calledNumber);
    case 'route.language':
      return on(policy.language);
    case 'route.path':
    case 'route.intent':
    case 'route.context':
      return on(policy.intent);
    case 'handover.summary':
    case 'handover.reason':
      return on(policy.summary);
    case 'handover.transcript':
      return on(policy.transcriptTurns > 0);
    case 'ticket.transcriptUrl':
      return on(policy.transcriptLink);
    default:
      return 'ok';
  }
}

const SLOT = /\{\{\s*([^{}]*?)\s*\}\}/g;

/**
 * Every problem in a webhook spec that needs no network: paths outside the context namespace or
 * switched off by the policy, `$`-keyed literals, a mapping over the depth or size limit, a nested
 * body for a `form` queue, and reserved or colliding headers. Pure; shared by the API's validate,
 * preview and test-webhook and by the worker before it sends.
 */
export function mappingIssues(spec: WebhookSpec, policy: QueueContextPolicy): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const add = (path: (string | number)[], code: MappingIssueCode, message: string) =>
    issues.push({ path, code, message });

  const checkPath = (at: (string | number)[], path: string) => {
    const verdict = contextPathVerdict(path, policy);
    if (verdict === 'unknown')
      add(at, 'routing_queue_mapping_invalid', `${path} is not a context field`);
    else if (verdict === 'disabled')
      add(
        at,
        'routing_queue_mapping_field_disabled',
        `${path} is switched off by the queue's context policy`,
      );
  };

  let nodes = 0;
  let deep = false;
  const walk = (value: unknown, at: (string | number)[], depth: number, top: boolean) => {
    nodes += 1;
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (spec.format === 'form')
        add(at, 'routing_queue_mapping_invalid', 'A form body is flat: no arrays');
      value.forEach((item, i) => walk(item, [...at, i], depth + 1, false));
      return;
    }
    if ('$from' in value) {
      if (!MappingRef.safeParse(value).success)
        add(
          at,
          'routing_queue_mapping_invalid',
          'A $from reference takes only default, maxChars and as',
        );
      else checkPath([...at, '$from'], (value as { $from: string }).$from);
      return;
    }
    if ('$template' in value) {
      if (!MappingTemplate.safeParse(value).success)
        add(
          at,
          'routing_queue_mapping_invalid',
          'A $template takes only maxChars besides the template',
        );
      else
        for (const slot of (value as { $template: string }).$template.matchAll(SLOT))
          checkPath([...at, '$template'], slot[1]!);
      return;
    }
    if (depth > MAPPING_LIMITS.depth && !deep) {
      deep = true;
      add(
        at,
        'routing_queue_mapping_invalid',
        `A mapping is at most ${MAPPING_LIMITS.depth} levels deep`,
      );
    }
    if (spec.format === 'form' && !top)
      add(at, 'routing_queue_mapping_invalid', 'A form body is flat: no nested objects');
    for (const [key, child] of Object.entries(value)) {
      if (key.startsWith('$'))
        add(
          [...at, key],
          'routing_queue_mapping_invalid',
          `${key}: keys starting with $ are reserved`,
        );
      walk(child, [...at, key], depth + 1, false);
    }
  };
  if (spec.body) walk(spec.body, ['body'], 1, true);
  else if (spec.format === 'form')
    add(
      ['body'],
      'routing_queue_mapping_invalid',
      'A form queue needs a body mapping: the default body is nested',
    );
  if (nodes > MAPPING_LIMITS.nodes)
    add(
      ['body'],
      'routing_queue_mapping_invalid',
      `A mapping has at most ${MAPPING_LIMITS.nodes} nodes`,
    );

  const seen = new Set<string>();
  const header = (at: (string | number)[], name: string, own: boolean) => {
    const lower = name.toLowerCase();
    if (
      (RESERVED_WEBHOOK_HEADERS as readonly string[]).includes(lower) ||
      lower.startsWith('x-ovo-')
    )
      add(at, 'routing_queue_mapping_invalid', `${name} is a reserved header`);
    else if (seen.has(lower)) add(at, 'routing_queue_mapping_invalid', `${name} is set twice`);
    else if (own) seen.add(lower);
  };
  for (const name of Object.keys(spec.headers)) header(['headers', name], name, true);
  if (spec.auth.kind === 'header') header(['auth', 'name'], spec.auth.name, true);
  return issues;
}
