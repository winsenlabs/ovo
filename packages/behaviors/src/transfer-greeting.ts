import type { AgentConfig, Inference, TransferHandover } from '@winsendotai/ovo-contracts';
import { stripInternalNotes } from './agent-stream.ts';

const TAKE_OVER =
  'You are taking over this call from a colleague. Greet the caller as the colleague taking over ' +
  'and acknowledge what they need in one short sentence. Do not ask them to repeat what they ' +
  'already said, and do not mention the transfer record.';
const ROUTED =
  'The routing desk has just connected this caller to you. Greet them and acknowledge what they ' +
  'asked for in one short sentence. Do not ask them to repeat what they already said.';

export interface GreetingHost {
  /** The briefing the agent's LLM reads (its context with the handover section). */
  briefing: () => string;
  /** The disclosure still owed, said first and heard in full (P5); undefined when none. */
  disclosure: () => string | undefined;
  /**
   * The checks every LLM reply passes (N4's language guard, then the reply guardrail): the line to
   * speak, which differs from the greeting (or is undefined) when either blocked or replaced it.
   */
  check: (line: string) => string | undefined;
  /** Speaks a conversational line. */
  say: (text: string) => string;
  /** The scripted opening (`ScriptedLines.opening`). */
  scripted: () => Iterable<string>;
  /** The opening turn's abort signal (cancelled with the turn). */
  signal: () => AbortSignal;
}

/**
 * R2 §7.9, the `llm` greeting of an agent that takes over a routed call: one LLM turn that greets
 * as the colleague taking over and acknowledges the request, with the handover in its context.
 * Without inference, for an agent that follows a flow (its start node speaks), for a return, or
 * when the model gives no usable line, the scripted opening plays instead; no inference is asked
 * for a greeting that is not `llm`. Its context holds untrusted data (the caller's words, another
 * model's summary), so the greeting is checked as any reply is, and one the checks would block or
 * replace is not said: the scripted opening plays instead.
 */
export class TransferGreeting {
  private readonly model?: Inference;

  constructor(
    private readonly config: AgentConfig,
    private readonly inbound: TransferHandover | undefined,
    inference: Inference | undefined,
    flow: boolean,
  ) {
    const llm = config.handoff?.agents?.inbound?.greeting === 'llm';
    if (inbound && inbound.kind !== 'return' && llm && !flow && inference) this.model = inference;
  }

  /** An `llm` greeting speaks first even with no opening lines. */
  speaksFirst(): boolean {
    return this.model !== undefined;
  }

  async *opening(host: GreetingHost): AsyncGenerator<string> {
    const asked = this.model && (await this.ask(this.model, host));
    const line = asked !== undefined && host.check(asked) === asked ? asked : undefined;
    if (line === undefined) return yield* host.scripted();
    const disclosure = host.disclosure();
    if (disclosure !== undefined) yield disclosure;
    yield host.say(line);
  }

  private async ask(model: Inference, host: GreetingHost): Promise<string | undefined> {
    const signal = host.signal();
    try {
      const reply = await model.generate({
        input: '(The caller is on the line, waiting for you.)',
        history: [],
        context: `${host.briefing()}\n\n${this.inbound?.kind === 'route' ? ROUTED : TAKE_OVER}`,
        uncertainty: this.config.uncertainty,
        tools: [],
        results: [],
        signal,
      });
      return reply.kind === 'text' ? stripInternalNotes(reply.text.trim()) || undefined : undefined;
    } catch (error) {
      signal.throwIfAborted();
      // A greeting is never worth a failed call: the scripted opening plays instead.
      void error;
      return undefined;
    }
  }
}
