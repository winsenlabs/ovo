import type {
  DecisionAnswer,
  DecisionPort,
  DecisionRequest,
  DecisionResponse,
  DecisionTrace,
} from '@winsendotai/ovo-contracts';

type FixtureIntent = {
  key: string;
  description: string;
  phrases?: string[];
  next?: string | { slot: string; cases: Record<string, string>; otherwise: string };
  repeat?: boolean;
};

/** Loosely typed so a test can break the flow in any way the schema still accepts. */
export type FlowFixture = {
  start: string;
  context: string;
  lines: Record<string, string>;
  nodes: {
    id: string;
    say: string[];
    listen?: string;
    end?: boolean;
    disposition?: string;
    verified?: boolean;
  }[];
  listens: {
    id: string;
    question: string;
    intents: FixtureIntent[];
    slots?: { id: string; question: string; options: { key: string; description: string }[] }[];
  }[];
  globalIntents: FixtureIntent[];
  repeatPrefix?: string;
};

/** A small slice of the POC collections map (poc/lib/flow.js), as authored flow JSON. */
export const collectionsFlow = (): FlowFixture => ({
  start: 'greet',
  context: 'A collections agent is on a phone call about a missed loan EMI.',
  lines: {
    intro: "Hello, I'm calling from CreditMantri.",
    ask_identity: 'Am I speaking with {{full_name}}?',
    reassure: 'I can only discuss this with {{full_name}}. Is that you?',
    emi: 'Your EMI of {{emi}} could not be collected.',
    ask_when: 'When would you be able to make this payment?',
    ptp_today: "Thank you. I've noted that you'll pay today.",
    ptp_tomorrow: "Thank you. I've noted that you'll pay tomorrow.",
    ptp_ask: 'Could you tell me a specific date?',
    anything_else: 'Is there anything else I can help you with?',
    wrong_person: 'Sorry for the trouble. Goodbye.',
    goodbye: 'Thank you for your time. Goodbye!',
    stop_calling: 'Understood. We will not call again. Goodbye.',
    repeat_prefix: 'Sure, let me repeat that.',
  },
  nodes: [
    { id: 'greet', say: ['intro', 'ask_identity'], listen: 'identity' },
    { id: 'reassure', say: ['reassure'], listen: 'identity' },
    { id: 'disclose', say: ['emi', 'ask_when'], listen: 'payment', verified: true },
    {
      id: 'ptp_today',
      say: ['ptp_today', 'anything_else'],
      listen: 'wrapup',
      disposition: 'promise_to_pay:today',
    },
    {
      id: 'ptp_tomorrow',
      say: ['ptp_tomorrow', 'anything_else'],
      listen: 'wrapup',
      disposition: 'promise_to_pay:tomorrow',
    },
    { id: 'ptp_ask', say: ['ptp_ask'], listen: 'payment' },
    { id: 'wrong_person', say: ['wrong_person'], end: true, disposition: 'wrong_number' },
    { id: 'goodbye', say: ['goodbye'], end: true },
    { id: 'stop_calling', say: ['stop_calling'], end: true, disposition: 'do_not_call' },
  ],
  listens: [
    {
      id: 'identity',
      question: 'The agent asked who picked up. How did they respond in `caller_reply`?',
      intents: [
        {
          key: 'confirmed',
          description: 'They confirm they are the named person',
          phrases: ['yes', 'haan ji', 'speaking'],
          next: 'disclose',
        },
        { key: 'wrong_person', description: 'It is a wrong number', next: 'wrong_person' },
        { key: 'asks_purpose', description: 'They ask why the agent is calling', next: 'reassure' },
      ],
    },
    {
      id: 'payment',
      question: 'The agent asked when they can pay. What does `caller_reply` express?',
      intents: [
        {
          key: 'promise_to_pay',
          description: 'They commit to paying later',
          next: {
            slot: 'ptp_when',
            cases: { today: 'ptp_today', tomorrow: 'ptp_tomorrow' },
            otherwise: 'ptp_ask',
          },
        },
      ],
      slots: [
        {
          id: 'ptp_when',
          question: 'By when do they say they will pay?',
          options: [
            { key: 'today', description: 'Today' },
            { key: 'tomorrow', description: 'Tomorrow' },
            { key: 'unspecified', description: 'No time given' },
          ],
        },
      ],
    },
    {
      id: 'wrapup',
      question: 'The agent asked if there is anything else. What does `caller_reply` say?',
      intents: [
        {
          key: 'no_more',
          description: 'Nothing else; they are done',
          phrases: ['no', 'thanks'],
          next: 'goodbye',
        },
      ],
    },
  ],
  globalIntents: [
    {
      key: 'repeat',
      description: 'They want the agent to repeat what it just said',
      phrases: ['sorry', 'pardon'],
      repeat: true,
    },
    { key: 'stop_calling', description: 'They ask not to be called again', next: 'stop_calling' },
  ],
  repeatPrefix: 'repeat_prefix',
});

export interface Scripted {
  intent: string;
  confidence?: number;
  slots?: Record<string, string>;
}

/** Answers every question of a request so the shared exchange validator accepts it. */
export function answerFor(request: DecisionRequest, scripted: Scripted): DecisionResponse {
  const answers: DecisionResponse['answers'] = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type !== 'choice') throw new Error('flow questions are choices');
    const keys = Object.keys(question.criteria);
    const pick = id === 'intent' ? scripted.intent : (scripted.slots?.[id] ?? keys.at(-1)!);
    const rest = keys.length > 1 ? 0.1 / (keys.length - 1) : 0;
    answers[id] = {
      type: 'choice',
      choice: pick,
      confidence: scripted.confidence ?? 0.9,
      calibrationVersion: 'jev-1/cohort-a',
      probabilities: Object.fromEntries(keys.map((key) => [key, key === pick ? 0.9 : rest])),
    } as DecisionAnswer;
  }
  return { modelId: 'jev-1', answers };
}

/** A decision port that answers from a script, recording each request and its trace. */
export function scriptedJev(script: (Scripted | Error)[]) {
  const requests: DecisionRequest[] = [];
  const traces: (DecisionTrace | undefined)[] = [];
  const port: DecisionPort = {
    decide: async (request, options) => {
      requests.push(request);
      traces.push(options.trace);
      const next = script.shift();
      if (!next) throw new Error('decision script exhausted');
      if (next instanceof Error) throw next;
      return answerFor(request, next);
    },
  };
  return { port, requests, traces };
}
