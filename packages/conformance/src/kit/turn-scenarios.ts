import type { Mode, TurnConfig, TurnDecision } from '@winsendotai/ovo-contracts';
import type { Driver } from './turn-driver.ts';

export interface TurnScenario {
  name: string;
  mode: Mode;
  /** Whether the host selected a VAD for this session (§2.7 'auto' → vad-timeout). */
  vad?: boolean;
  overrides?: Partial<TurnConfig>;
  run(d: Driver): string[];
}

const hasSpeech = (d: Driver, text: string) =>
  d.stopped().some((t) => t.kind === 'speech' && t.text.toLowerCase().includes(text));

/** The §2.7 mute semantics, confirmation answers, DTMF and idle. */
export const TURN_SCENARIOS: readonly TurnScenario[] = [
  {
    name: 'a speech turn stops on provider end-of-turn',
    mode: 'faq',
    run: (d) => {
      d.say('what are your opening hours');
      return hasSpeech(d, 'opening hours') ? [] : ['no turn.stopped for the utterance'];
    },
  },
  {
    name: 'a long utterance barges in while the bot speaks',
    mode: 'faq',
    run: (d) => {
      d.botStarts();
      d.say('please stop talking now', false);
      return d.interrupts() === 1 ? [] : [`expected one interrupt, saw ${d.interrupts()}`];
    },
  },
  {
    name: "a backchannel while the bot speaks resets the turn as 'backchannel'",
    mode: 'faq',
    run: (d) => {
      d.botStarts();
      d.say('uh huh');
      const out: string[] = [];
      if (d.interrupts() || d.stopped().length)
        out.push('backchannel interrupted or became a turn');
      if (!d.resets().includes('backchannel'))
        out.push(`no turn.reset{reason:'backchannel'}, saw ${JSON.stringify(d.resets())}`);
      return out;
    },
  },
  {
    name: "'yes' during the confirmation prompt is buffered and released at bot.stopped",
    mode: 'agent',
    run: (d) => {
      d.signal('confirmation.pending');
      d.botStarts('confirmation');
      d.say('yes');
      const early = d.stopped().length || d.interrupts();
      d.botStops('confirmation');
      const out: string[] = [];
      if (early) out.push('the answer was released or interrupted before the prompt finished');
      if (!hasSpeech(d, 'yes')) out.push("'yes' was not released at bot.stopped");
      return out;
    },
  },
  {
    name: "'no that's not correct' during the prompt is released as a no",
    mode: 'agent',
    run: (d) => {
      d.signal('confirmation.pending');
      d.botStarts('confirmation');
      d.say("no that's not correct");
      d.botStops('confirmation');
      return hasSpeech(d, 'no') && !d.interrupts() ? [] : ['the no was not released as a turn'];
    },
  },
  {
    name: "a random 'hello' during the prompt is reset as 'muted'",
    mode: 'agent',
    run: (d) => {
      d.signal('confirmation.pending');
      d.botStarts('confirmation');
      d.say('hello there');
      d.botStops('confirmation');
      const out: string[] = [];
      if (d.stopped().length || d.interrupts())
        out.push("'hello' became a turn or interrupted the prompt");
      if (!d.resets().includes('muted'))
        out.push(`no turn.reset{reason:'muted'}, saw ${JSON.stringify(d.resets())}`);
      return out;
    },
  },
  {
    name: 'answers are never backchannels while a confirmation is pending',
    mode: 'agent',
    run: (d) => {
      d.signal('confirmation.pending');
      d.say('yes');
      d.botStarts();
      d.say('haan ji');
      const interrupted = d.interrupts();
      d.botStops();
      const answers = d.stopped().filter((t) => t.kind === 'speech');
      const out =
        answers.length === 2 ? [] : [`expected both answers as turns, saw ${answers.length}`];
      return interrupted ? [...out, 'an answer over bot speech was treated as a barge-in'] : out;
    },
  },
  {
    name: 'during tools speech is discarded but DTMF is allowed',
    mode: 'agent',
    run: (d) => {
      d.signal('tool.started');
      d.say('hello are you still there');
      d.dtmf('1#');
      d.signal('tool.settled');
      const out: string[] = [];
      if (d.stopped().some((t) => t.kind === 'speech'))
        out.push('speech during a tool became a turn');
      if (!d.stopped().some((t) => t.kind === 'dtmf' && t.text === '1'))
        out.push('DTMF during a tool was dropped');
      return out;
    },
  },
  {
    name: "a turn already under way when a tool starts is reset as 'muted'",
    mode: 'agent',
    run: (d) => {
      d.say('i would like to', false);
      d.signal('tool.started');
      d.say('book a table for two');
      d.signal('tool.settled');
      const out: string[] = [];
      if (!d.resets().includes('muted'))
        out.push(`no turn.reset{reason:'muted'}, saw ${JSON.stringify(d.resets())}`);
      if (d.stopped().some((t) => t.kind === 'speech'))
        out.push('speech during a tool became a turn');
      return out;
    },
  },
  {
    name: 'announcement mode never barges in',
    mode: 'announcement',
    run: (d) => {
      d.botStarts();
      d.say('stop stop stop please', false);
      return d.interrupts() ? ['announcement speech was interrupted'] : [];
    },
  },
  {
    name: 'a disclosure segment is always muted',
    mode: 'faq',
    run: (d) => {
      d.botStarts('disclosure');
      d.say('please stop right now');
      d.botStops('disclosure');
      return d.interrupts() || d.stopped().length ? ['speech during a disclosure was used'] : [];
    },
  },
  {
    name: 'DTMF digits collect until the terminator or the inter-digit timeout',
    mode: 'faq',
    run: (d) => {
      d.dtmf('123#');
      d.dtmf('4');
      d.clock.advance(2500);
      const digits = d
        .stopped()
        .filter((t) => t.kind === 'dtmf')
        .map((t) => t.text);
      return JSON.stringify(digits) === JSON.stringify(['123', '4'])
        ? []
        : [`DTMF turns were ${JSON.stringify(digits)}`];
    },
  },
  {
    name: 'idle prompts after silence, then ends',
    mode: 'faq',
    run: (d) => {
      d.botStarts();
      d.botStops();
      d.clock.advance(10_500);
      const first = d.decisions.filter((x) => x.type === 'idle');
      d.botStarts('idle-prompt');
      d.botStops('idle-prompt');
      d.clock.advance(10_500);
      const all = d.decisions.filter(
        (x): x is Extract<TurnDecision, { type: 'idle' }> => x.type === 'idle',
      );
      const out: string[] = [];
      if (first.length !== 1 || all[0]?.final) out.push('no idle prompt after the first timeout');
      if (all.length !== 2 || !all[1]?.final) out.push('no final idle decision after the retry');
      return out;
    },
  },
];
