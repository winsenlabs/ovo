import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type DecisionPort,
  type DecisionRequest,
  type Execution,
  type InferenceReply,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../../../behaviors/src/index.ts';
import { collect, llm, receipt } from '../../../behaviors/tests/agent-call-control-fixture.ts';
import { CREDITMANTRI_JEV_EVAL } from '../../../plugin-evaluations/src/corpus/jev-eval-creditmantri.ts';
import { CREDITMANTRI_GOLDEN } from '../../../plugin-evaluations/src/corpus/golden-creditmantri.ts';
import { matchFlowPhrase } from '../../../plugin-evaluations/src/jev-eval-flow.ts';
import { flowToday, type SpokenEntry } from '../../../plugin-evaluations/src/jev-eval-state.ts';
import {
  jevEvalHistory,
  jevEvalNode,
  jevEvalRequest,
} from '../../../plugin-evaluations/src/jev-eval.ts';
import {
  ReferenceConversation,
  scriptedAnswer,
  type GoldenConversation,
  type GoldenStep,
  type GoldenTurn,
} from '../../../plugin-evaluations/src/jev-eval-conversation.ts';

/**
 * AGT-16 golden conversations: the POC conversation map, imported as flow JSON, walked turn by turn
 * with fixture STT (the caller's final transcripts), fixture decisions and LLM replies, and TTS as
 * the exact rendered lines. Deterministic and offline.
 */

const imported = JSON.parse(
  readFileSync(
    new URL('../../../plugin-evaluations/src/corpus/creditmantri-flow.json', import.meta.url),
    'utf8',
  ),
);
const { variables, clock, flow } = CREDITMANTRI_JEV_EVAL;
const today = flowToday(clock);
const GREET = [
  "Hello, I'm calling from CreditMantri. My name is Ananya.",
  'Am I speaking with Rahul Sharma?',
];

/** Every turn of a conversation on the reference walk, the opening first. */
function walk(conversation: GoldenConversation) {
  const reference = new ReferenceConversation(flow, { variables, today, idle: imported.idle });
  const turns: GoldenTurn[] = [reference.start()];
  for (const step of conversation.steps)
    turns.push(
      step.caller === null
        ? reference.silence()
        : reference.reply(step.caller, {
            ...(step.decision ? { decision: step.decision } : {}),
            ...(step.llm ? { llm: step.llm } : {}),
          }),
    );
  return { reference, turns };
}

describe('CreditMantri golden conversations, reference walk', () => {
  it('covers the cases AGT-16 names and every node of the flow', () => {
    const ids = CREDITMANTRI_GOLDEN.map((conversation) => conversation.id);
    for (const id of ['ptp-goodbye', 'wrong-number', 'repeat', 'idle-twice', 'other-llm-resume'])
      expect(ids).toContain(id);
    const entered = new Set(
      CREDITMANTRI_GOLDEN.flatMap((conversation) => walk(conversation).turns.map((t) => t.node)),
    );
    const missing = flow.nodes.map((node) => node.id).filter((id) => !entered.has(id));
    expect(missing).toEqual(['cb_evening', 'cb_tomorrow_evening', 'cb_generic']);
  });

  for (const conversation of CREDITMANTRI_GOLDEN)
    it(`${conversation.id}: ${conversation.title}`, () => {
      const { reference, turns } = walk(conversation);
      expect(turns[0]).toEqual({ tier: 'start', node: 'greet', says: GREET, end: false });
      conversation.steps.forEach((step, index) => {
        const turn = turns[index + 1]!;
        const { says, end, ...route } = step.expect;
        expect({ ...turn, says: undefined }, `step ${index + 1}`).toMatchObject({
          ...route,
          end: end ?? false,
        });
        if (route.node === undefined) expect(turn.node, `step ${index + 1}`).toBeUndefined();
        if (says) expect(turn.says, `step ${index + 1}`).toEqual(says);
      });
      expect({
        node: reference.node,
        ended: reference.ended,
        dispositions: reference.dispositions,
        verified: reference.verified,
      }).toEqual(conversation.outcome);
    });
});

/**
 * The same conversations on the agent runtime: `AgentBehavior` with the imported flow as its
 * decision policy, a fixture decision port and a fixture LLM that rejoins through `resume_flow`.
 * The flow runtime is the flow lane's (wave3/flow), so this block runs only once the agent config
 * accepts `decision.flow`; until the lanes are integrated it is skipped, and the integrator's
 * merge is what turns it on. Idle handling lives in the engine's turn driver (jevonly lane), not in
 * a behaviour turn, so silence conversations stay todo here.
 */
const agentConfig = {
  name: 'CreditMantri collections',
  mode: 'agent',
  locale: clock.locale,
  timezone: clock.timezone,
  variables: imported.variables,
  decision: imported.decision,
  idle: imported.idle,
};
const parsed = AgentConfig.safeParse(agentConfig);
const flowRuntime = parsed.success;
// A caller silence is an `inputEvent: 'idle'` turn once the agent takes an idle policy (AGT-11,
// wave3/jevonly). Before that the key is dropped on parse, and silence conversations stay todo.
const idleRuntime = flowRuntime && 'idle' in parsed.data;
const NOW = new Date(clock.now);
const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

function dispositionsOf(behavior: AgentBehavior): string[] {
  return behavior.decisions.flatMap((record) => {
    const step = (record.result as { step?: { transition?: { disposition?: string } } }).step;
    return step?.transition?.disposition ? [step.transition.disposition] : [];
  });
}

/**
 * An agent on the imported flow that answers `steps`' scripted decisions and LLM replies in order,
 * then hands any further decision to `after`. Every segment it says is played on its own receipt.
 */
function runtimeCall(id: string, steps: readonly GoldenStep[], after?: DecisionPort['decide']) {
  const script = steps.flatMap((step) => (step.decision ? [step.decision] : []));
  const port: DecisionPort = {
    decide: async (request, options) => {
      const next = script.shift();
      if (next) return scriptedAnswer(request, next);
      if (after) return after(request, options);
      throw new Error('decision script exhausted');
    },
  };
  const model = llm(
    steps.flatMap((step): InferenceReply[] =>
      step.llm
        ? [
            {
              kind: 'tool',
              toolId: 'resume_flow',
              input: { reply: step.llm.reply, resume_at: step.llm.resumeAt, action: 'none' },
            },
          ]
        : [],
    ),
  );
  const behavior = new AgentBehavior(AgentConfig.parse(agentConfig), model.port, execution, {
    workspaceId: 'w-golden',
    sessionId: `s-${id}`,
    decision: port,
    now: () => NOW,
  });
  let epoch = 0;
  // What was said, as one text: how a node's lines are split into speech segments is the
  // engine's and the clip cache's business, not the conversation's. `cut` is a caller barging in
  // before any line finished: the engine cancels the turn, then the lines report interrupted.
  const turn = async (text: string, extra: Record<string, unknown> = {}, cut = false) => {
    behavior.beginTurn(epoch);
    const said = await collect(behavior.respondStream(text, { ...variables, ...extra }));
    if (cut) behavior.cancel('turn interrupted');
    for (const segment of said)
      behavior.onPlayback(receipt(segment, epoch, cut ? 'interrupted' : 'completed'));
    epoch += 1;
    return said.join(' ');
  };
  // Greet-first when the agent speaks first, as the engine runs it; otherwise the flow enters its
  // start node on the caller's first words, whatever they are.
  const greetsFirst = behavior.speaksFirst();
  const open = () => (greetsFirst ? turn('', { inputEvent: 'opening' }) : turn(OPENING_HELLO));
  return { behavior, script, turn, open, greetsFirst };
}
const OPENING_HELLO = 'Hello?';

/**
 * The 2026-10-07 live calls on the imported flow, where the caller barges in: what a golden step
 * cannot express, since every golden line plays to its end. Caller words are the calls' own.
 */
describe.skipIf(!flowRuntime)('CreditMantri live-call regressions, agent runtime', () => {
  const lines = flow.lines as Record<string, string>;
  const render = (id: string) =>
    lines[id]!.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(variables[name as never]));
  const DISCLOSE = ['recording', 'emi_status', 'charges', 'ask_when'].map(render).join(' ');

  it('call B: a cut disclosure is said again, and only then counts as heard', async () => {
    const { behavior, turn, open } = runtimeCall('live-disclosure', [
      { caller: '', decision: { intent: 'confirmed', confidence: 0.73 }, expect: { tier: 'rule' } },
      { caller: '', decision: { intent: 'other', confidence: 0.44 }, expect: { tier: 'rule' } },
    ]);
    await open();
    expect(await turn('Yes, sir. It takes a lot of time.', {}, true)).toBe(DISCLOSE);
    expect(behavior.flow!.verified).toBe(false);
    expect(await turn('It is not.')).toBe(DISCLOSE);
    expect(behavior.flow!.verified).toBe(true);
    expect(behavior.flow!.path.at(-1)).toMatchObject({ reason: 'unheard' });
  });

  it('call B: a cut do-not-call goodbye is said once more and the call ends, never reopened', async () => {
    const { behavior, turn, open } = runtimeCall('live-dnc', [
      {
        caller: '',
        decision: { intent: 'stop_calling', confidence: 0.92 },
        expect: { tier: 'decision' },
      },
    ]);
    await open();
    await turn('Yes, sir.');
    const goodbye = render('stop_calling');
    expect(await turn('Stop calling me. Do not call this number again.', {}, true)).toBe(goodbye);
    // Call B rejoined at identity here and disclosed the loan again.
    expect(await turn('Okay, so listen to me one by one.', {}, true)).toBe(goodbye);
    expect(await turn('What is your name?')).toBe('');
    expect(behavior.isComplete()).toBe(true);
    expect(behavior.completionReason()).toBe('decision:flow:stop_calling');
    expect(dispositionsOf(behavior)).toEqual(['do_not_call_requested']);
  });
});

describe.skipIf(!flowRuntime)('CreditMantri golden conversations, agent runtime', () => {
  for (const conversation of CREDITMANTRI_GOLDEN) {
    const silent = conversation.steps.some((step) => step.caller === null);
    if (silent && !idleRuntime) {
      it.todo(`${conversation.id}: needs the agent idle policy (AGT-11, wave3/jevonly)`);
      continue;
    }
    it(conversation.id, async () => {
      const expected = walk(conversation).turns;
      const { behavior, script, turn, open } = runtimeCall(conversation.id, conversation.steps);
      const text = (index: number) => expected[index]!.says.join(' ');
      expect(await open()).toBe(text(0));
      // The engine times a silence; the behaviour only says what it means.
      for (const [index, step] of conversation.steps.entries())
        expect(
          await (step.caller === null ? turn('', { inputEvent: 'idle' }) : turn(step.caller)),
          `step ${index + 1}`,
        ).toBe(text(index + 1));
      expect(script).toEqual([]);
      expect(dispositionsOf(behavior)).toEqual(conversation.outcome.dispositions);
      expect(behavior.isComplete()).toBe(conversation.outcome.ended);
      // The reason names the ending node; the agent prefixes the source (`decision:flow:<node>`).
      // Silence ends the call as no input instead (the engine's `caller_idle`).
      if (conversation.outcome.ended)
        expect(behavior.completionReason()).toMatch(
          conversation.steps.at(-1)!.caller === null
            ? /^idle:no-input$/
            : new RegExp(`(^|:)flow:${conversation.outcome.node}$`),
        );
    });
  }

  // The Jev eval scores the request it builds itself (`jevEvalRequest`). This drives the agent down
  // each decided case's golden route and checks the runtime asks exactly that, state included.
  it('asks every decided Jev eval case with the request the eval scores', async () => {
    const set = CREDITMANTRI_JEV_EVAL;
    for (const evalCase of set.cases) {
      if (matchFlowPhrase(flow, evalCase.listen, evalCase.text)) continue;
      const path = set.paths[jevEvalNode(set, evalCase)]!;
      const steps = CREDITMANTRI_GOLDEN.find(
        (conversation) => conversation.id === path.conversation,
      )!.steps.slice(0, path.steps);
      const asked: DecisionRequest[] = [];
      const call = runtimeCall(`eval-${evalCase.id}`, steps, async (request) => {
        asked.push(request);
        return scriptedAnswer(request, {
          intent: evalCase.expected,
          ...(evalCase.slots ? { slots: evalCase.slots } : {}),
        });
      });
      await call.open();
      for (const step of steps) await call.turn(step.caller!);
      await call.turn(evalCase.text);
      const history: SpokenEntry[] = [
        ...(call.greetsFirst ? [] : [{ role: 'caller' as const, text: OPENING_HELLO }]),
        ...jevEvalHistory(set, evalCase),
      ];
      expect(asked, evalCase.id).toEqual([jevEvalRequest(set, evalCase, history)]);
    }
  });
});
