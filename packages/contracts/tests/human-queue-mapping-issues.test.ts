import { describe, expect, it } from 'vitest';
import {
  contextPathVerdict,
  EXTERNAL_CONTEXT_DEFAULT,
  MANAGED_CONTEXT_DEFAULT,
  mappingIssues,
  WebhookSpec,
  type QueueContextPolicy,
} from '../src/index.ts';
import { body, context, policy, spec } from './human-queue-mapping-fixture.ts';

describe('contextPathVerdict', () => {
  it('gates every policy-controlled field', () => {
    const off: QueueContextPolicy = {
      callerId: false,
      calledNumber: false,
      language: false,
      intent: false,
      summary: false,
      transcriptTurns: 0,
      transcriptLink: false,
      variables: [],
      summarize: 'agent_only',
    };
    for (const path of [
      'caller.number',
      'caller.calledNumber',
      'route.language',
      'route.intent',
      'route.path',
      'route.context.tier',
      'handover.summary',
      'handover.reason',
      'handover.transcript',
      'ticket.transcriptUrl',
      'variables.account_id',
    ])
      expect(contextPathVerdict(path, off), path).toBe('disabled');
    for (const path of [
      'call.id',
      'call.direction',
      'call.startedAt',
      'queue.key',
      'queue.id',
      'queue.name',
      'ticket.id',
      'ticket.idempotencyKey',
      'ticket.priority',
      'ticket.callbackUrl',
      'ticket.contextUrl',
      'ticket.expiresAt',
      'ticket.event',
      'time.now',
    ])
      expect(contextPathVerdict(path, off), path).toBe('ok');
  });

  it('enables a field when its policy flag is on, and variables by allow-list or declared', () => {
    expect(contextPathVerdict('caller.number', policy({ callerId: true }))).toBe('ok');
    expect(contextPathVerdict('handover.transcript', policy({ transcriptTurns: 3 }))).toBe('ok');
    expect(contextPathVerdict('variables.account_id', policy({ variables: ['account_id'] }))).toBe(
      'ok',
    );
    expect(contextPathVerdict('variables.other', policy({ variables: ['account_id'] }))).toBe(
      'disabled',
    );
    expect(contextPathVerdict('variables.anything', MANAGED_CONTEXT_DEFAULT)).toBe('ok');
  });

  it('calls unknown namespaces, leaves and depths unknown', () => {
    for (const path of [
      'nope.x',
      'caller',
      'caller.nope',
      'caller.number.more',
      'call.id.more',
      'route.context.a.b',
      'variables',
      'variables.a.b',
      'bad path',
      '',
      'ticket.secret',
    ])
      expect(contextPathVerdict(path, policy({ callerId: true })), path).toBe('unknown');
  });
});

describe('mappingIssues', () => {
  const codes = (found: { code: string }[]) => found.map((issue) => issue.code);

  it('finds nothing wrong with a default spec or the worked mapping', () => {
    expect(mappingIssues(spec(), EXTERNAL_CONTEXT_DEFAULT)).toEqual([]);
    expect(
      mappingIssues(
        body({
          a: { $from: 'call.id' },
          b: { $template: '{{route.intent}} {{queue.name}}' },
          c: [1, 'x', { $from: 'ticket.callbackUrl' }],
        }),
        EXTERNAL_CONTEXT_DEFAULT,
      ),
    ).toEqual([]);
  });

  it('routing_queue_mapping_field_disabled: a $from or template slot the policy switched off', () => {
    const found = mappingIssues(
      body({ ani: { $from: 'caller.number' }, t: { $template: 'x {{handover.transcript}}' } }),
      EXTERNAL_CONTEXT_DEFAULT,
    );
    expect(found).toEqual([
      expect.objectContaining({
        code: 'routing_queue_mapping_field_disabled',
        path: ['body', 'ani', '$from'],
      }),
      expect.objectContaining({
        code: 'routing_queue_mapping_field_disabled',
        path: ['body', 't', '$template'],
      }),
    ]);
  });

  it('routing_queue_mapping_invalid: an unknown path or template slot', () => {
    const found = mappingIssues(
      body({
        a: { $from: 'caller.nope' },
        b: { $template: '{{ nope }}' },
        c: { $from: 'ticket.secret' },
      }),
      EXTERNAL_CONTEXT_DEFAULT,
    );
    expect(codes(found)).toEqual([
      'routing_queue_mapping_invalid',
      'routing_queue_mapping_invalid',
      'routing_queue_mapping_invalid',
    ]);
  });

  it('routing_queue_mapping_invalid: more than six levels or two hundred nodes', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 6; i += 1) nested = { n: nested };
    expect(codes(mappingIssues(body(nested), EXTERNAL_CONTEXT_DEFAULT))).toEqual([
      'routing_queue_mapping_invalid',
    ]);
    let ok: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 4; i += 1) ok = { n: ok };
    expect(mappingIssues(body(ok), EXTERNAL_CONTEXT_DEFAULT)).toEqual([]);
    const wide = Object.fromEntries(
      Array.from({ length: 5 }, (_, a) => [
        `a${a}`,
        Object.fromEntries(Array.from({ length: 45 }, (_, b) => [`b${b}`, b])),
      ]),
    );
    expect(codes(mappingIssues(body(wide), EXTERNAL_CONTEXT_DEFAULT))).toEqual([
      'routing_queue_mapping_invalid',
    ]);
  });

  it('routing_queue_mapping_invalid: a form body must be flat, and needs a mapping', () => {
    expect(
      mappingIssues(
        spec({ format: 'form', body: { a: { $from: 'call.id' }, b: 'x' } }),
        EXTERNAL_CONTEXT_DEFAULT,
      ),
    ).toEqual([]);
    for (const bad of [{ a: [1] }, { a: { b: 1 } }]) {
      const found = mappingIssues(spec({ format: 'form', body: bad }), EXTERNAL_CONTEXT_DEFAULT);
      expect(codes(found)).toEqual(['routing_queue_mapping_invalid']);
      expect(found[0]!.message).toMatch(/flat/);
    }
    const missing = mappingIssues(spec({ format: 'form' }), EXTERNAL_CONTEXT_DEFAULT);
    expect(missing).toEqual([
      expect.objectContaining({ code: 'routing_queue_mapping_invalid', path: ['body'] }),
    ]);
  });

  it('routing_queue_mapping_invalid: $-keyed literals and malformed references, when the spec is not parsed', () => {
    const raw = {
      ...spec(),
      body: { $x: 1, ref: { $from: 'call.id', bogus: 1 }, tpl: { $template: 'x', bogus: 1 } },
    } as unknown as WebhookSpec;
    const found = mappingIssues(raw, EXTERNAL_CONTEXT_DEFAULT);
    expect(found.map((issue) => issue.path)).toEqual([
      ['body', '$x'],
      ['body', 'ref'],
      ['body', 'tpl'],
    ]);
    expect(new Set(codes(found))).toEqual(new Set(['routing_queue_mapping_invalid']));
  });

  it('routing_queue_mapping_invalid: reserved, x-ovo and duplicate headers', () => {
    const found = mappingIssues(
      spec({
        headers: {
          'Content-Type': 'text/plain',
          'X-OVO-Secret': 'x',
          Authorization: 'x',
          'X-Mine': '1',
          'x-mine': '2',
          'Idempotency-Key': 'k',
        },
      }),
      EXTERNAL_CONTEXT_DEFAULT,
    );
    expect(found.map((issue) => issue.path[1])).toEqual([
      'Content-Type',
      'X-OVO-Secret',
      'Authorization',
      'x-mine',
      'Idempotency-Key',
    ]);
    expect(new Set(codes(found))).toEqual(new Set(['routing_queue_mapping_invalid']));
  });

  it('routing_queue_mapping_invalid: an auth header that is reserved or repeats a static header', () => {
    const auth = (name: string) => ({ kind: 'header', name, credentialId: 'k' });
    expect(codes(mappingIssues(spec({ auth: auth('Cookie') }), EXTERNAL_CONTEXT_DEFAULT))).toEqual([
      'routing_queue_mapping_invalid',
    ]);
    expect(
      codes(
        mappingIssues(
          spec({ auth: auth('X-Key'), headers: { 'x-key': '1' } }),
          EXTERNAL_CONTEXT_DEFAULT,
        ),
      ),
    ).toEqual(['routing_queue_mapping_invalid']);
    expect(mappingIssues(spec({ auth: auth('X-Api-Key') }), EXTERNAL_CONTEXT_DEFAULT)).toEqual([]);
  });
});
