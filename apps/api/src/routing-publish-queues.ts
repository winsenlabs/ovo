import {
  HUMAN_METER_KEYS,
  mappingIssues,
  type HumanQueueDefinition,
  type RouteLines,
} from '@winsendotai/ovo-contracts';
import { endpointIssue } from './human-queue-validate.ts';
import type { Add, RoutingCheckInput } from './routing-publish-checks.ts';
import { routerRef } from './routing-publish-resolve.ts';
import { credentialReady } from './session-factory.ts';

/** Languages the built-in `human` line and the hold's built-ins are authored in. */
const BUILT_IN_LINE_LANGUAGES = new Set(['en', 'hi']);
/** The call limit under which a human conversation is cut short (15 minutes). */
const MIN_CALL_SECONDS = 900;

/**
 * What publish needs to know about the installation to judge a queue: whether the feature and its
 * parts are switched on, whether a room server is composed, and who is staffed.
 */
export interface HumanQueueCheckEnvironment {
  /** `OVO_HUMAN_QUEUE_ENABLED`. */
  enabled: boolean;
  /** `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`. */
  webhookEnabled: boolean;
  /** A `Cap.mediaRoom` provider is composed in this API. */
  roomConfigured: boolean;
  operators(): Promise<readonly { enabled: boolean; teamIds: readonly string[] }[]>;
}

/** Every line a queue authors, with where, so coverage can be checked against the point's languages. */
function authoredLines(definition: HumanQueueDefinition): { at: string; lines: RouteLines }[] {
  const found: { at: string; lines: RouteLines }[] = [];
  if (definition.announcement) found.push({ at: 'announcement', lines: definition.announcement });
  definition.hold?.steps.forEach((step, index) => {
    if (step.kind === 'line') found.push({ at: `hold.steps.${index}`, lines: step.line });
  });
  definition.hold?.onTimeout.forEach((step, index) => {
    if (step.kind === 'callback' || step.kind === 'end')
      found.push({ at: `hold.onTimeout.${index}`, lines: step.line });
  });
  return found;
}

/** A webhook queue's own checks: endpoint, credentials, mapping, destination allow-list. */
async function externalIssues(
  input: RoutingCheckInput,
  definition: Extract<HumanQueueDefinition, { kind: 'external' }>,
  path: (string | number)[],
  add: Add,
): Promise<void> {
  const { webhook } = definition;
  if (!input.humanQueues?.webhookEnabled)
    add(
      'routing_queue_webhook_disabled',
      path,
      'External queues stay inert until OVO_HUMAN_QUEUE_WEBHOOK_ENABLED is true',
      'warning',
    );
  const endpoint = endpointIssue(webhook.url, [...path, 'webhook', 'url']);
  if (endpoint) add('routing_queue_endpoint_invalid', endpoint.path, endpoint.message);
  const router = { workspaceId: input.workspaceId, id: input.draft.router.agentId };
  const credentials: [string, (string | number)[]][] = [
    [webhook.credentialId, [...path, 'webhook', 'credentialId']],
    ...(webhook.auth.kind === 'none'
      ? []
      : [
          [webhook.auth.credentialId, [...path, 'webhook', 'auth', 'credentialId']] as [
            string,
            (string | number)[],
          ],
        ]),
  ];
  for (const [id, at] of credentials)
    try {
      await credentialReady(input.store, router, id);
    } catch {
      add(
        'routing_queue_credential_missing',
        at,
        'The credential is missing, inactive, expired or not permitted for the router agent',
      );
    }
  for (const found of mappingIssues(webhook, definition.context))
    add(found.code, [...path, 'webhook', ...found.path], found.message);
  if (
    !definition.destination.allowE164Prefixes.length &&
    !definition.destination.allowSipHosts.length
  )
    add(
      'routing_queue_destination_policy_empty',
      [...path, 'destination'],
      'A webhook queue needs an allow-list of number prefixes or SIP hosts',
    );
}

/** A desk queue's own checks: a room server, staffing, and the human meters. */
async function managedIssues(
  input: RoutingCheckInput,
  definition: Extract<HumanQueueDefinition, { kind: 'managed' }>,
  path: (string | number)[],
  add: Add,
): Promise<void> {
  const environment = input.humanQueues;
  if (!environment?.roomConfigured)
    add(
      'routing_queue_room_unavailable',
      path,
      'No room server is composed, so operators cannot answer calls in the browser',
      'warning',
    );
  const operators = environment ? await environment.operators() : [];
  const staffed = operators.some(
    (operator) =>
      operator.enabled &&
      (definition.teamIds.length === 0 ||
        definition.teamIds.some((team) => operator.teamIds.includes(team))),
  );
  if (!staffed)
    add(
      'routing_queue_no_operators',
      path,
      'No enabled operator belongs to this queue’s teams',
      'warning',
    );
  const priced = routerRef(input.resolution).release?.config.costPolicy?.priceCards ?? {};
  const unpriced = Object.values(HUMAN_METER_KEYS).filter((key) => !(key in priced));
  if (unpriced.length)
    add(
      'routing_queue_meter_unpriced',
      path,
      `The router’s cost policy does not price ${unpriced.join(', ')}; operator time is metered but costs nothing`,
      'warning',
    );
}

/**
 * Every resolution check of a bound human queue (design 4.8), after the ones structural validation
 * already made: the queue exists and is live, the feature and its parts are on, a webhook queue's
 * endpoint, credentials, mapping and allow-list are sound, a desk queue has a room server and
 * staff, and the lines it speaks cover the point's languages. Warnings never block a publish.
 */
export async function queueIssues(input: RoutingCheckInput, add: Add): Promise<void> {
  const { draft, resolution } = input;
  for (const [index, binding] of (draft.humanQueues ?? []).entries()) {
    const path = ['humanQueues', index];
    const found = resolution.queues.get(binding.queueId);
    if (found === 'deleted') {
      add('routing_queue_deleted', [...path, 'queueId'], `Queue ${binding.queueId} was deleted`);
      continue;
    }
    if (!found) {
      add('routing_queue_missing', [...path, 'queueId'], `Queue ${binding.queueId} was not found`);
      continue;
    }
    const { definition } = found;
    if (!input.humanQueues?.enabled)
      add(
        'routing_queue_disabled',
        path,
        'Human queues report disabled until OVO_HUMAN_QUEUE_ENABLED is true',
        'warning',
      );
    if (!input.transferEnabled)
      add(
        'routing_queue_transfer_required',
        path,
        'Human queues act only with OVO_ROUTING_TRANSFER_ENABLED; the queue stays inert',
        'warning',
      );
    if (definition.kind === 'external') await externalIssues(input, definition, path, add);
    else await managedIssues(input, definition, path, add);

    const wanted = draft.language.default;
    const gaps = authoredLines(definition).filter(({ lines }) => !(wanted in lines));
    if (gaps.length || (!definition.announcement && !BUILT_IN_LINE_LANGUAGES.has(wanted)))
      add(
        'routing_queue_language_uncovered',
        path,
        `The queue’s lines${gaps.length ? ` (${gaps.map(({ at }) => at).join(', ')})` : ''} have none in ${wanted}, the point's default language`,
        'warning',
      );
    const limit = routerRef(resolution).release?.config.costPolicy?.maxCallSeconds;
    if (limit !== undefined && limit < MIN_CALL_SECONDS)
      add(
        'routing_queue_call_limit_short',
        path,
        `The router’s call limit is ${limit} s; a human conversation inside it may be cut short`,
        'warning',
      );
  }
}
