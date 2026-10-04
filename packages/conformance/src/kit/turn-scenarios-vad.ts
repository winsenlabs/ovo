import type { TurnScenario } from './turn-scenarios.ts';

/**
 * Every detector used to be created with `vad: false`, so the 'vad-timeout' strategy and the
 * force-endpoint decision were never run at all (#F22). These scenarios select a VAD.
 */
export const TURN_VAD_SCENARIOS: readonly TurnScenario[] = [
  {
    name: "'auto' becomes vad-timeout when a VAD is selected and ends a turn without end-of-turn",
    mode: 'faq',
    vad: true,
    run: (d) => {
      d.vadStart();
      d.say('what are your opening hours', false);
      d.vadStop();
      d.clock.advance(700);
      const spoken = d.stopped().filter((t) => t.kind === 'speech');
      return spoken.some((t) => t.text.toLowerCase().includes('opening hours'))
        ? []
        : [`no turn.stopped after the VAD went quiet, saw ${JSON.stringify(spoken)}`];
    },
  },
  {
    name: 'speech resuming before the timeout does not end the turn early',
    mode: 'faq',
    vad: true,
    run: (d) => {
      d.vadStart();
      d.say('what are your', false);
      d.vadStop();
      d.clock.advance(300);
      d.vadStart();
      const early = d.stopped().length || d.forceEndpoints();
      d.say('opening hours', false);
      d.vadStop();
      d.clock.advance(700);
      const out: string[] = [];
      if (early) out.push('the turn ended before userSpeechTimeoutMs elapsed');
      if (!d.stopped().some((t) => t.kind === 'speech'))
        out.push('the turn never ended after the VAD finally went quiet');
      return out;
    },
  },
  {
    name: 'force-endpoint is requested when the VAD stops before any transcript arrives',
    mode: 'faq',
    vad: true,
    run: (d) => {
      d.vadStart();
      d.vadStop();
      d.clock.advance(700);
      const forced = d.forceEndpoints();
      if (forced !== 1) return [`expected one force-endpoint, saw ${forced}`];
      d.say('i am still here', false);
      return d.stopped().some((t) => t.kind === 'speech')
        ? []
        : ['the transcript that arrived after force-endpoint never became a turn'];
    },
  },
  {
    name: 'the explicit provider strategy ignores the VAD timeout',
    mode: 'faq',
    vad: true,
    overrides: { strategy: 'provider' },
    run: (d) => {
      d.vadStart();
      d.say('what are your opening hours', false);
      d.vadStop();
      d.clock.advance(5000);
      const out: string[] = [];
      if (d.stopped().length) out.push("strategy 'provider' ended a turn on the VAD timeout");
      if (d.forceEndpoints()) out.push("strategy 'provider' emitted force-endpoint");
      return out;
    },
  },
];
