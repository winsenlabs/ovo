import { sleep } from './runner.ts';
import { FAQ, spoken, type EngineScenario } from './engine-scenario-setup.ts';

const STATS = [
  'acceptedFrames',
  'acceptedBytes',
  'pendingFrames',
  'pendingBytes',
  'overflows',
] as const;

/** Session-level surface that no scenario used to touch (#F18). */
export const SESSION_SCENARIOS: readonly EngineScenario[] = [
  {
    name: 'answeredBy from the carrier becomes a voicemail event',
    setup: { agent: FAQ },
    async run(h, f) {
      await h.stt.session(0);
      h.carrier.caller.answeredBy('machine');
      await h.until(
        () => h.events().some((e) => e.type === 'voicemail'),
        'the voicemail event for answeredBy',
      );
      const event = h.events().find((e) => e.type === 'voicemail');
      f.expect(
        event?.type === 'voicemail' && event.result === 'machine',
        `the voicemail event is ${JSON.stringify(event)}`,
      );
    },
  },
  {
    name: 'the session watchdog ends the call at maxCallSeconds',
    setup: { agent: FAQ, session: { maxCallSeconds: 1 } },
    async run(h, f) {
      const outcome = await Promise.race([h.engine.ended, sleep(6000).then(() => undefined)]);
      f.expect(
        outcome?.reason === 'max_duration',
        `ended with ${outcome?.reason ?? 'nothing'} instead of max_duration`,
      );
      f.expect(outcome?.outcome === 'limit', `outcome ${outcome?.outcome ?? 'none'}`);
      f.expect(h.carrier.closed, 'the watchdog did not close media');
    },
  },
  {
    name: 'ingress stats, user transcripts, the transcript observer and timings are reported',
    setup: { agent: FAQ },
    async run(h, f) {
      h.carrier.caller.audio(new Uint8Array(160));
      await h.say('what are your opening hours');
      await h.until(() => spoken(h, /nine to five/), 'the FAQ answer');
      const stats = h.engine.ingressStats;
      for (const field of STATS)
        f.expect(
          typeof stats[field] === 'number' && Number.isFinite(stats[field]) && stats[field] >= 0,
          `ingressStats.${field} is ${stats[field]}`,
        );
      f.expect(
        stats.acceptedBytes >= 160 && stats.acceptedFrames >= 1,
        `ingressStats counted ${stats.acceptedFrames} frames / ${stats.acceptedBytes} bytes after 160 B of caller audio`,
      );
      const finals = h
        .events()
        .filter((e) => e.type === 'user.transcript' && e.stability === 'final');
      f.expect(
        finals.some((e) => e.type === 'user.transcript' && /opening hours/.test(e.text)),
        'no final user.transcript event carried what the caller said',
      );
      f.expect(
        h.transcripts.length > 0,
        'the EnginePorts.transcripts observer never received an event',
      );
      f.expect(
        h.transcripts.some((e) => e.type === 'user.transcript') &&
          h.transcripts.some((e) => e.type === 'agent.transcript'),
        'the transcript observer saw only one side of the conversation',
      );
      const timings = h.events().filter((e) => e.type === 'timing');
      f.expect(timings.length > 0, 'the engine emitted no timing events for a spoken turn');
    },
  },
];
