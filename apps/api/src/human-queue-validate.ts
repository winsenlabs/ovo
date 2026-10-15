import {
  HumanQueueDefinition,
  mappingIssues,
  type HumanQueueDefinition as QueueDefinition,
} from '@winsendotai/ovo-contracts';
import type { ControlStore } from '@winsendotai/ovo-plugin-storage';
import { parseApprovedEndpoint } from '@winsendotai/ovo-plugin-tools-http';
import { zodIssues, type ApiIssue } from './routes/human-queue-support.ts';

export type QueueValidation =
  { ok: true; definition: QueueDefinition; issues: ApiIssue[] } | { ok: false; issues: ApiIssue[] };

const issue = (path: (string | number)[], code: string, message: string): ApiIssue => ({
  path,
  code,
  message,
});

/** The issue for a webhook endpoint that is not public HTTPS without credentials or a fragment. */
export function endpointIssue(url: string, path: (string | number)[]): ApiIssue | undefined {
  try {
    parseApprovedEndpoint(url, { allowQuery: true });
    return undefined;
  } catch {
    return issue(
      path,
      'routing_queue_endpoint_invalid',
      'The endpoint must be public HTTPS without credentials or a fragment',
    );
  }
}

/** A credential id that must name an active credential of this workspace. */
async function credentialIssue(
  store: Pick<ControlStore, 'getCredential'>,
  workspaceId: string,
  id: string,
  path: (string | number)[],
): Promise<ApiIssue | undefined> {
  const credential = id ? await store.getCredential(workspaceId, id) : undefined;
  if (!credential || credential.status !== 'active')
    return issue(path, 'routing_queue_credential_missing', 'Choose an active credential');
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now())
    return issue(path, 'routing_queue_credential_missing', 'This credential has expired');
  return undefined;
}

/**
 * Everything the API can say about a queue definition before saving it (design 6.1): the schema,
 * the mapping against the context policy, the endpoint, and that the signing and extra-auth
 * credentials exist. Whether the router agent may use them is checked at publish, where the
 * router is known. No network is touched.
 */
export async function validateQueueDefinition(
  raw: unknown,
  context: { store: Pick<ControlStore, 'getCredential'>; workspaceId: string },
): Promise<QueueValidation> {
  const parsed = HumanQueueDefinition.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      issues: zodIssues(parsed.error),
    };
  const definition = parsed.data;
  const issues: ApiIssue[] = [];
  if (definition.kind === 'external') {
    const { webhook } = definition;
    for (const found of mappingIssues(webhook, definition.context))
      issues.push(issue(['webhook', ...found.path], found.code, found.message));
    const endpoint = endpointIssue(webhook.url, ['webhook', 'url']);
    if (endpoint) issues.push(endpoint);
    const checks = [
      credentialIssue(context.store, context.workspaceId, webhook.credentialId, [
        'webhook',
        'credentialId',
      ]),
      ...(webhook.auth.kind === 'none'
        ? []
        : [
            credentialIssue(context.store, context.workspaceId, webhook.auth.credentialId, [
              'webhook',
              'auth',
              'credentialId',
            ]),
          ]),
    ];
    for (const found of await Promise.all(checks)) if (found) issues.push(found);
  }
  return issues.length ? { ok: false, issues } : { ok: true, definition, issues };
}
