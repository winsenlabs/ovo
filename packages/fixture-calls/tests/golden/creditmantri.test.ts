import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AgentConfig,
  type DecisionPort,
  type Execution,
  type InferenceReply,
} from '@winsendotai/ovo-contracts';
import { AgentBehavior } from '../../../behaviors/src/index.ts';
import { collect, llm, receipt } from '../../../behaviors/tests/agent-call-control-fixture.ts';
import { CREDITMANTRI_JEV_EVAL } from '../../../plugin-evaluations/src/corpus/jev-eval-creditmantri.ts';
import { CREDITMANTRI_GOLDEN } from '../../../plugin-evaluations/src/corpus/golden-creditmantri.ts';
import {
  ReferenceConversation,
  scriptedAnswer,
  type GoldenConversation,
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
const { variables, today, flow } = CREDITMANTRI_JEV_EVAL;
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
  variables: imported.variables,
  decision: imported.decision,
};
const flowRuntime = AgentConfig.safeParse(agentConfig).success;
const NOW = new Date('2026-10-07T06:30:00Z');
const execution: Execution = { execute: async () => ({ state: 'succeeded' }) as never };

function dispositionsOf(behavior: AgentBehavior): string[] {
  return behavior.decisions.flatMap((record) => {
    const step = (record.result as { step?: { transition?: { disposition?: string } } }).step;
    return step?.transition?.disposition ? [step.transition.disposition] : [];
  });
}

describe.skipIf(!flowRuntime)('CreditMantri golden conversations, agent runtime', () => {
  for (const conversation of CREDITMANTRI_GOLDEN) {
    if (conversation.steps.some((step) => step.caller === null)) {
      it.todo(`${conversation.id}: idle runs in the turn driver, not a behaviour turn`);
      continue;
    }
    it(conversation.id, async () => {
      const expected = walk(conversation).turns;
      const script = conversation.steps.flatMap((step) => (step.decision ? [step.decision] : []));
      const port: DecisionPort = {
        decide: async (request) => {
          const next = script.shift();
          if (!next) throw new Error('decision script exhausted');
          return scriptedAnswer(request, next);
        },
      };
      const model = llm(
        conversation.steps.flatMap((step): InferenceReply[] =>
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
        sessionId: `s-${conversation.id}`,
        decision: port,
        now: () => NOW,
      });
      let epoch = 0;
      // What was said, compared as one text: how a node's lines are split into speech segments
      // is the engine's and the clip cache's business, not the conversation's.
      const turn = async (text: string) => {
        behavior.beginTurn(epoch);
        const said = await collect(behavior.respondStream(text, variables));
        for (const segment of said) behavior.onPlayback(receipt(segment, epoch));
        epoch += 1;
        return said.join(' ');
      };
      const text = (index: number) => expected[index]!.says.join(' ');
      // A flow enters its start node on the first turn, whatever the caller said.
      expect(await turn('Hello?')).toBe(text(0));
      for (const [index, step] of conversation.steps.entries())
        expect(await turn(step.caller!), `step ${index + 1}`).toBe(text(index + 1));
      expect(script).toEqual([]);
      expect(dispositionsOf(behavior)).toEqual(conversation.outcome.dispositions);
      expect(behavior.isComplete()).toBe(conversation.outcome.ended);
      // The reason names the ending node; the agent prefixes the source (`decision:flow:<node>`).
      if (conversation.outcome.ended)
        expect(behavior.completionReason()).toMatch(
          new RegExp(`(^|:)flow:${conversation.outcome.node}$`),
        );
    });
  }
});
