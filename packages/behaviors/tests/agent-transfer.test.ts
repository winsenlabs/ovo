import { describe, expect, it, vi } from 'vitest';
import { Cap, type Behavior, type ToolDefinition } from '@winsendotai/ovo-contracts';
import { compose, definePlugin } from '@winsendotai/ovo-runtime';
import { createAgentBehaviorPlugin } from '../src/index.ts';
import { collect, llm } from './agent-call-control-fixture.ts';
import {
  ANNOUNCE,
  billing,
  senior,
  transferAgent,
  transferCall,
  transferPort,
} from './transfer-fixture.ts';

const toolOf = (tools: readonly ToolDefinition[]) =>
  tools.find((tool) => tool.id === 'transfer_to_agent');

describe('transfer_to_agent: when it is offered', () => {
  it('with llmTool, the port and granted targets: an enum of keys, summary required', async () => {
    const t = transferAgent();
    await t.turn('I was double charged');
    const tool = toolOf(t.model!.requests[0]!.tools)!;
    expect(tool.inputSchema).toMatchObject({
      required: ['target', 'summary'],
      additionalProperties: false,
      properties: {
        target: {
          enum: ['billing', 'senior_desk'],
          description:
            'billing: Payments, refunds, double charges | senior_desk: The caller asks for a senior colleague',
        },
        reason: { maxLength: 200 },
        summary: { maxLength: 1_000 },
        confirmed: { type: 'boolean' },
      },
    });
  });

  it('without the summary when the point hands over none', async () => {
    const t = transferAgent({ port: transferPort({ summary: false }) });
    await t.turn('hello');
    const schema = toolOf(t.model!.requests[0]!.tools)!.inputSchema as Record<string, any>;
    expect(schema.required).toEqual(['target']);
    expect(schema.properties).not.toHaveProperty('summary');
  });

  it.each([
    ['no llmTool', { agents: { llmTool: false } }],
    ['no granted target', { port: transferPort({ targets: [] }) }],
  ])('never with %s', async (_name, options) => {
    const t = transferAgent(options);
    await t.turn('hello');
    expect(toolOf(t.model!.requests[0]!.tools)).toBeUndefined();
  });

  it('direct-call parity: without the port the request is exactly as with no transfer config', async () => {
    const plain = transferAgent({ port: null, agents: { llmTool: false } });
    const optedIn = transferAgent({ port: null });
    await plain.turn('hello');
    await optedIn.turn('hello');
    const strip = ({ signal: _signal, ...request }: Record<string, unknown>) => request;
    expect(strip(optedIn.model!.requests[0] as never)).toEqual(
      strip(plain.model!.requests[0] as never),
    );
    expect(toolOf(optedIn.model!.requests[0]!.tools)).toBeUndefined();
  });

  it('reads the port as an optional capability of the agent plugin', async () => {
    const port = transferPort();
    const fixture = (key: string, value: unknown) =>
      definePlugin(
        {
          id: `fixture.${key}`,
          version: '0.1.0',
          contractVersion: 1,
          scope: 'session',
          requires: [],
          provides: [key],
          configSchema: { type: 'object' },
          secretFields: [],
        },
        (ctx) => (ctx as unknown as { provide(k: string, v: unknown): void }).provide(key, value),
      );
    const model = llm([transferCall('billing')]);
    const plugin = createAgentBehaviorPlugin();
    expect(plugin.manifest).toMatchObject({
      optional: expect.arrayContaining([Cap.agentTransfer]),
    });
    const services = [
      fixture(Cap.execution, { execute: async () => ({ state: 'succeeded' }) }),
      fixture(Cap.inference, model.port),
      fixture(Cap.agentTransfer, port.port),
    ];
    const agent = { name: 'Sales', mode: 'agent', handoff: { agents: { llmTool: true } } };
    const composition = await compose(
      [
        ...services.map((service) => ({ id: service.manifest.id })),
        { id: plugin.manifest.id, config: { agent, workspaceId: 'w', sessionId: 's' } },
      ],
      [...services, plugin],
    );
    try {
      const behavior = composition.ctx.get(Cap.behavior) as Behavior;
      expect(await behavior.respond('my bill is wrong')).toBe(ANNOUNCE);
      expect(port.commits).toEqual(['t1']);
    } finally {
      await composition.dispose();
    }
  });
});

describe('transfer_to_agent: an accepted transfer', () => {
  it('commits before arming, says the announcement as the whole reply, ends handoff:<key>', async () => {
    const t = transferAgent({ replies: [transferCall('billing', { reason: 'double charge' })] });
    const arm = vi.spyOn((t.behavior as unknown as { ending: { arm: () => void } }).ending, 'arm');
    const armedAtCommit: number[] = [];
    const commit = t.port!.port.commit;
    t.port!.port.commit = (id) => {
      armedAtCommit.push(arm.mock.calls.length);
      commit(id);
    };
    const said = await t.turn('I was double charged', {}, false);
    expect(said).toEqual([ANNOUNCE]);
    expect(t.model!.requests).toHaveLength(1);
    expect(t.port!.requests).toEqual([
      {
        key: 'billing',
        source: 'llm',
        reason: 'double charge',
        summary: 'Double charged on the October bill.',
        confirmed: false,
      },
    ]);
    expect(armedAtCommit).toEqual([0]);
    expect(arm).toHaveBeenCalledWith('handoff:billing', { final: true });
    expect(t.behavior.isComplete()).toBe(false);
    t.behavior.onPlayback({
      id: 'a',
      text: ANNOUNCE,
      epoch: 1,
      state: 'completed',
      evidence: 'confirmed',
    });
    expect(t.behavior.isComplete()).toBe(true);
    expect(t.behavior.completionReason()).toBe('handoff:billing');
  });

  it('a barge-in on the announcement keeps the committed transfer', async () => {
    const t = transferAgent({ replies: [transferCall('billing')] });
    await t.turn('I was double charged', {}, 'interrupted');
    t.behavior.cancel();
    expect(await t.turn('wait, one more thing')).toEqual([]);
    expect(t.behavior.isComplete()).toBe(true);
    expect(t.behavior.completionReason()).toBe('handoff:billing');
    expect(t.model!.requests).toHaveLength(1);
    expect(t.port!.requests).toHaveLength(1);
    expect(t.port!.cancels).toEqual([]);
  });

  it('a caller turn before the announcement played ends the segment, saying nothing', async () => {
    const t = transferAgent({ replies: [transferCall('billing')] });
    await t.turn('I was double charged', {}, false);
    t.behavior.cancel();
    expect(await t.turn('hello? are you there?', {}, false)).toEqual([]);
    expect(t.behavior.isComplete()).toBe(true);
    expect(t.behavior.completionReason()).toBe('handoff:billing');
    expect(t.model!.requests).toHaveLength(1);
  });

  it('a turn superseded while the host answered cancels the transfer instead of committing', async () => {
    let release!: () => void;
    const port = transferPort({
      result: () =>
        new Promise((done) => {
          release = () =>
            done({ ok: true, transferId: 'late', announcement: ANNOUNCE, queued: false });
        }),
    });
    const t = transferAgent({ port, replies: [transferCall('billing')] });
    t.behavior.beginTurn(1);
    const said = collect(t.behavior.respondStream('I was double charged'));
    await vi.waitFor(() => expect(port.requests).toHaveLength(1));
    t.behavior.cancel();
    release();
    await said.catch(() => undefined);
    expect(port.cancels).toEqual(['late']);
    expect(port.commits).toEqual([]);
    expect(t.behavior.completionReason()).toBeUndefined();
  });

  it('a refusal is a record the model reads, and the model answers the caller', async () => {
    const port = transferPort({ result: () => ({ ok: false, reason: 'ping_pong' }) });
    const t = transferAgent({
      port,
      replies: [
        transferCall('billing'),
        { kind: 'text', text: 'Let me help you with that myself.' },
      ],
    });
    expect(await t.turn('send me back to sales')).toEqual(['Let me help you with that myself.']);
    expect(t.model!.requests[1]!.results).toMatchObject([
      {
        toolId: 'transfer_to_agent',
        state: 'failed',
        error: expect.stringMatching(/not available/),
      },
    ]);
    expect(port.commits).toEqual([]);
    expect(t.behavior.isComplete()).toBe(false);
  });

  it('a full team is told as such', async () => {
    const port = transferPort({ result: () => ({ ok: false, reason: 'pool_full' }) });
    const t = transferAgent({ port, replies: [transferCall('billing')] });
    await t.turn('billing please');
    expect(t.model!.requests[1]!.results[0]).toMatchObject({
      error: expect.stringMatching(/Nobody/),
    });
  });
});

describe('transfer_to_agent: the confirm gate', () => {
  const QUESTION = 'Shall I transfer you to senior desk?';

  it('asks first, with no second model step and nothing asked of the host', async () => {
    const t = transferAgent({ replies: [transferCall('senior_desk')] });
    expect(await t.turn('can I talk to your manager')).toEqual([QUESTION]);
    expect(t.port!.requests).toEqual([]);
    expect(t.model!.requests).toHaveLength(1);
  });

  it('goes ahead on a caller yes to that question', async () => {
    const t = transferAgent({
      replies: [transferCall('senior_desk'), transferCall('senior_desk', { confirmed: true })],
    });
    await t.turn('can I talk to your manager');
    expect(await t.turn('yes please')).toEqual([ANNOUNCE]);
    expect(t.port!.requests).toMatchObject([{ key: 'senior_desk', confirmed: true }]);
    expect(t.port!.commits).toEqual(['t1']);
  });

  it('refuses a confirmation the model claims without a caller yes', async () => {
    const t = transferAgent({ replies: [transferCall('senior_desk', { confirmed: true })] });
    expect(await t.turn('get me your manager')).toEqual([QUESTION]);
    expect(t.port!.requests).toMatchObject([{ key: 'senior_desk', confirmed: false }]);
    expect(t.port!.commits).toEqual([]);
    expect(t.behavior.isComplete()).toBe(false);
  });

  it('a yes to some other question is no yes to this one', async () => {
    const t = transferAgent({
      replies: [
        { kind: 'text', text: 'Is your account number ending in 42?' },
        transferCall('senior_desk', { confirmed: true }),
      ],
    });
    await t.turn('hello');
    expect(await t.turn('yes')).toEqual([QUESTION]);
    expect(t.port!.commits).toEqual([]);
  });

  it('a no is the model to answer: the caller declined', async () => {
    const t = transferAgent({
      replies: [
        transferCall('senior_desk'),
        transferCall('senior_desk', { confirmed: true }),
        { kind: 'text', text: 'No problem. What else can I do?' },
      ],
    });
    await t.turn('can I talk to your manager');
    expect(await t.turn('no, not now')).toEqual(['No problem.', 'What else can I do?']);
    expect(t.port!.requests).toEqual([]);
    expect(t.model!.requests[2]!.results[0]).toMatchObject({
      state: 'failed',
      error: expect.stringMatching(/declined/),
    });
  });

  it('an unclear answer is asked again', async () => {
    const t = transferAgent({
      replies: [transferCall('senior_desk'), transferCall('senior_desk', { confirmed: true })],
    });
    await t.turn('can I talk to your manager');
    expect(await t.turn('what would that do')).toEqual([QUESTION]);
    expect(t.port!.commits).toEqual([]);
  });

  it('asks in the agent base language with the label the port gives in it', async () => {
    const port = transferPort({ targets: [{ ...senior, label: 'वरिष्ठ सहयोगी' }] });
    const t = transferAgent({
      port,
      over: { language: 'hi-IN', locale: 'hi-IN' },
      replies: [transferCall('senior_desk')],
    });
    expect(await t.turn('manager se baat karni hai')).toEqual([
      'क्या मैं आपको वरिष्ठ सहयोगी से जोड़ दूँ?',
    ]);
  });

  it('a never target goes straight to the host', async () => {
    const t = transferAgent({
      port: transferPort({ targets: [billing] }),
      replies: [transferCall('billing')],
    });
    expect(await t.turn('billing')).toEqual([ANNOUNCE]);
  });
});
