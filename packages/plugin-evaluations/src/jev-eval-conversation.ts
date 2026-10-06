import {
  validateDecisionExchange,
  type DecisionRequest,
  type DecisionResponse,
} from '@winsendotai/ovo-contracts';
import {
  FLOW_INTENT_QUESTION,
  FLOW_OTHER_INTENT,
  flowDecisionRequest,
  flowNode,
  matchFlowPhrase,
  renderFlowLine,
  routeFlowIntent,
  type AgentFlow,
} from './jev-eval-flow.ts';

/**
 * The reference walk of a flow, turn by turn, with scripted decision and LLM answers: what the
 * POC's `lib/call.js` does, on the flow JSON. The golden conversations are checked against it so
 * they are known-good before any runtime runs them; a runtime that disagrees with a golden
 * conversation is then wrong, not the script.
 */

export type GoldenTier = 'start' | 'rule' | 'decision' | 'llm' | 'idle';

export interface GoldenTurn {
  tier: GoldenTier;
  intent?: string;
  /** The node entered; absent when the turn replays, falls back or prompts. */
  node?: string;
  says: string[];
  end: boolean;
}

export interface GoldenStep {
  /** The caller's final transcript, or null for a silence (an idle timeout). */
  caller: string | null;
  decision?: ScriptedDecision;
  llm?: ScriptedLlm;
  expect: { tier: GoldenTier; intent?: string; node?: string; says?: string[]; end?: boolean };
}

export interface GoldenConversation {
  id: string;
  title: string;
  steps: GoldenStep[];
  outcome: { node: string; ended: boolean; dispositions: string[]; verified: boolean };
}

export interface ScriptedDecision {
  intent: string;
  confidence?: number;
  slots?: Record<string, string>;
}

export interface ScriptedLlm {
  reply: string;
  /** A listen set the flow offers, or `end`. */
  resumeAt: string;
}

/** Answers every question of a flow request, the way a decision model would shape it. */
export function scriptedAnswer(request: DecisionRequest, scripted: ScriptedDecision) {
  const answers: DecisionResponse['answers'] = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'choice') throw new Error('Flow questions are choices');
    const keys = Object.keys(question.criteria);
    const pick =
      id === FLOW_INTENT_QUESTION ? scripted.intent : (scripted.slots?.[id] ?? keys.at(-1)!);
    const rest = 0.1 / (keys.length - 1);
    answers[id] = {
      type: 'choice',
      choice: pick,
      confidence: scripted.confidence ?? 0.9,
      calibrationVersion: 'golden',
      probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 0.9 : rest])),
    };
  }
  return validateDecisionExchange(request, { modelId: 'golden', answers }).response;
}

export class ReferenceConversation {
  readonly dispositions: string[] = [];
  verified = false;
  ended = false;
  node?: string;
  listen?: string;
  /** The entered node's lines, which a repeat replays. */
  private last: string[] = [];
  /** What the agent said since the caller last spoke, for the decision state. */
  private spoken: string[] = [];
  private silences = 0;

  constructor(
    private readonly flow: AgentFlow,
    private readonly options: {
      variables: Record<string, string>;
      today: string;
      idle: { prompts: string[]; finalLine: string };
    },
  ) {}

  start(): GoldenTurn {
    return this.enter(this.flow.start, 'start');
  }

  /** One caller reply. `decision` answers it when no phrase does; `llm` when nothing fits. */
  reply(
    text: string,
    scripted: { decision?: ScriptedDecision; llm?: ScriptedLlm } = {},
  ): GoldenTurn {
    if (this.ended || !this.listen) throw new Error('The conversation has ended');
    this.silences = 0;
    const listen = this.listen;
    const ruled = matchFlowPhrase(this.flow, listen, text);
    if (ruled) return this.follow(listen, ruled, {}, 'rule');
    if (!scripted.decision) throw new Error(`"${text}" needs a scripted decision`);
    const request = flowDecisionRequest(this.flow, listen, {
      caller_reply: text,
      agent_last_said: this.spoken.join(' '),
      recent_turns: this.spoken.map((line) => `agent: ${line}`),
      today: this.options.today,
    });
    const answer = scriptedAnswer(request, scripted.decision).answers;
    const intent = answer[FLOW_INTENT_QUESTION]!;
    if (intent.type !== 'choice') throw new Error('unreachable');
    if (intent.choice !== FLOW_OTHER_INTENT && intent.confidence >= this.flow.threshold) {
      const slots: Record<string, string> = {};
      for (const [id, slot] of Object.entries(answer))
        if (
          id !== FLOW_INTENT_QUESTION &&
          slot.type === 'choice' &&
          slot.confidence >= this.flow.threshold
        )
          slots[id] = slot.choice;
      return this.follow(listen, intent.choice, slots, 'decision');
    }
    // The LLM answers what the flow could not place and names where the flow resumes.
    if (!scripted.llm) throw new Error(`"${text}" falls back to the LLM, which is not scripted`);
    const { reply, resumeAt } = scripted.llm;
    if (resumeAt === 'end') this.ended = true;
    else if (!this.flow.listens.some((candidate) => candidate.id === resumeAt))
      throw new Error(`The LLM cannot resume at ${resumeAt}`);
    else this.listen = resumeAt;
    return this.said({ tier: 'llm', says: [reply], end: this.ended });
  }

  /** The caller said nothing: the next idle prompt, then the closing line and the end. */
  silence(): GoldenTurn {
    const prompt = this.options.idle.prompts[this.silences++];
    if (prompt !== undefined) return this.said({ tier: 'idle', says: [prompt], end: false });
    this.ended = true;
    return this.said({ tier: 'idle', says: [this.options.idle.finalLine], end: true });
  }

  private follow(
    listen: string,
    intent: string,
    slots: Record<string, string>,
    tier: GoldenTier,
  ): GoldenTurn {
    const target = routeFlowIntent(this.flow, listen, intent, slots);
    if (!target) throw new Error(`${intent} is not an intent of ${listen}`);
    if (target.kind === 'node') return { ...this.enter(target.node, tier), intent };
    const prefix = this.flow.repeatPrefix ? [this.render(this.flow.repeatPrefix)] : [];
    return this.said({ tier, intent, says: [...prefix, ...this.last], end: false });
  }

  private enter(id: string, tier: GoldenTier): GoldenTurn {
    const node = flowNode(this.flow, id);
    if (!node) throw new Error(`Unknown node ${id}`);
    this.node = node.id;
    this.listen = node.listen;
    this.ended = node.end;
    if (node.verified) this.verified = true;
    if (node.disposition) this.dispositions.push(node.disposition);
    this.last = node.say.map((line) => this.render(line));
    return this.said({ tier, node: node.id, says: [...this.last], end: node.end });
  }

  private said(turn: GoldenTurn): GoldenTurn {
    this.spoken = turn.says;
    return turn;
  }

  private render(line: string): string {
    return renderFlowLine(this.flow, line, this.options.variables);
  }
}
