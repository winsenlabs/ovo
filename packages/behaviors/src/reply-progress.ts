import {
  END_CALL_TOOL_ID,
  FLOW_RESUME_TOOL_ID,
  type Inference,
  type InferenceRequest,
  type InferenceStreamEvent,
} from '@winsendotai/ovo-contracts';

/*
 * How far the reply to each playback epoch has come, for the engine's filler (Wave 9 D6, Wave 10
 * L3). Moved out of agent-stream.ts in Wave 12 to keep both modules under the size limit.
 */

/**
 * Tools whose call brings its words with it: a goodbye (`end_call`, or the question asked in its
 * place) or the flow's reply (`resume_flow`) is spoken as soon as the call arrives.
 */
const SPEAKING_TOOLS = new Set([END_CALL_TOOL_ID, FLOW_RESUME_TOOL_ID]);

/** A tool call that brings no words: the agent's own tool runs before the reply is composed. */
function looksUp(reply: { kind: string; toolId?: string }): boolean {
  return reply.kind === 'tool' && !SPEAKING_TOOLS.has(reply.toolId!);
}

/** What `noticingWords` tells about the requests the reply makes. */
interface ReplyNotes {
  /** The model's first words, or a tool call that brings them, are in (Wave 9, D6). */
  drafted: () => void;
  /** A request was sent. */
  sent: (request: InferenceRequest) => void;
  /** The model called one of the agent's own tools (Wave 10, L3). */
  tool: () => void;
}

/**
 * `events`, telling `drafted` once the model's first words arrive (Wave 9, D6), or a tool call
 * that brings them (Wave 10, L3: call 4f1a919d turn 11's end_call came 0.21 s after its filler),
 * and `tool` for any other tool call.
 */
async function* noticeWords(
  events: AsyncIterable<InferenceStreamEvent>,
  notes: ReplyNotes,
): AsyncGenerator<InferenceStreamEvent> {
  let drafted: (() => void) | undefined = notes.drafted;
  for await (const event of events) {
    const words =
      (event.kind === 'text-delta' && event.delta.trim()) ||
      (event.kind === 'tool' && SPEAKING_TOOLS.has(event.toolId));
    if (drafted && words) {
      drafted();
      drafted = undefined;
    }
    if (looksUp(event)) notes.tool();
    yield event;
  }
}

/**
 * How far the reply to each playback epoch has come, for the engine's filler: its first words are
 * in (Wave 9, D6), and whether it may take a while to look something up (Wave 10, L3): a model
 * request sent the provider's own tools (a web search), or a call to one of the agent's own tools
 * (review of ec1194c: "Yes, please." to "Shall I check the open slots?" ran `check_slots` for
 * 3 s, and heard no filler).
 */
export class ReplyProgress {
  private drafted?: number;
  private asked?: { epoch: number; lookingUp: boolean };

  /**
   * `inference` as the reply composed in `epoch` asks it, while `current()`; `limited` says which
   * requests go with the provider's tools (`Inference.sendsProviderTools`).
   */
  follow(
    inference: Inference,
    epoch: number | undefined,
    current: () => boolean,
    limited?: Inference,
  ): Inference {
    if (epoch === undefined) return inference;
    // Once a reply looks something up it stays looking up: its next step is sent the results.
    const asked = (lookingUp: boolean) => {
      if (current()) this.asked = { epoch, lookingUp: lookingUp || this.lookingUp(epoch) === true };
    };
    return noticingWords(inference, {
      drafted: () => {
        if (current()) this.drafted = epoch;
      },
      sent: (request) => asked(limited?.sendsProviderTools?.(request) ?? false),
      tool: () => asked(true),
    });
  }

  drafting(epoch: number | undefined): boolean {
    return epoch !== undefined && this.drafted === epoch;
  }

  lookingUp(epoch: number | undefined): boolean | undefined {
    return epoch !== undefined && this.asked?.epoch === epoch ? this.asked.lookingUp : undefined;
  }
}

/** `inference`, telling `notes` of each request, its first words and its tool calls. */
function noticingWords(inference: Inference, notes: ReplyNotes): Inference {
  const stream = inference.stream;
  return {
    ...(inference.provider ? { provider: inference.provider } : {}),
    ...(inference.model ? { model: inference.model } : {}),
    generate: async (request) => {
      notes.sent(request);
      const reply = await inference.generate(request);
      if (looksUp(reply)) notes.tool();
      return reply;
    },
    ...(stream
      ? {
          stream: (request: InferenceRequest) => {
            notes.sent(request);
            return noticeWords(stream.call(inference, request), notes);
          },
        }
      : {}),
  };
}
