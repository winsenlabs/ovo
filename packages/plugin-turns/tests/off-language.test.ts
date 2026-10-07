import { describe, expect, it } from 'vitest';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import type { TurnDecision, VoiceEvent } from '@winsendotai/ovo-contracts';
import { createTurnDetector, DetectorConfigSchema } from '../src/index.ts';

type WithoutTime<T> = T extends unknown ? Omit<T, 'atMs'> : never;

function fixture(languages?: string[]) {
  const clock = new FakeClock();
  const decisions: TurnDecision[] = [];
  // The opening's own protection (N8, opening.test.ts) is off, so these show the language rule
  // alone deciding what barges in on the greeting.
  const opening = { protectMs: 0, confirmWords: false };
  const controller = createTurnDetector(languages ? { languages, opening } : { opening }).create({
    clock,
    vad: false,
    language: 'en-IN',
    mode: 'agent',
  });
  controller.on((decision) => decisions.push(decision));
  let segment = 0;
  const send = (event: WithoutTime<VoiceEvent>) =>
    controller.observe({ ...event, atMs: clock.now() } as VoiceEvent);
  const transcript = (text: string, stability: 'interim' | 'final', id = `s${segment}`) =>
    send({
      type: 'stt',
      event: { type: 'transcript', segment: { segmentId: id, revision: 1, text, stability } },
    });
  const say = (interim: string, final: string) => {
    segment += 1;
    transcript(interim, 'interim');
    transcript(final, 'final');
    send({ type: 'stt', event: { type: 'end-of-turn' } });
  };
  const of = <T extends TurnDecision['type']>(type: T) =>
    decisions.filter((d): d is Extract<TurnDecision, { type: T }> => d.type === type);
  const turns = () =>
    of('turn.stopped').flatMap((d) => (d.input.kind === 'speech' ? [d.input.text] : []));
  return { clock, send, say, of, turns };
}

const greeting = { type: 'bot.started', epoch: 1, kind: 'response' } as const;

describe('words outside the agent languages (N4)', () => {
  it('never barge in on the greeting (call b1fd8b51) and are no turn over it', () => {
    const f = fixture(['en', 'hi']);
    f.send(greeting);
    f.say('Знаете, что?', 'Нет, это всё.');
    expect(f.of('interrupt')).toEqual([]);
    expect(f.turns()).toEqual([]);
    expect(f.of('turn.reset').map((d) => d.reason)).toEqual(['backchannel']);
  });

  it('still barge in when they are in an allowed language, code-mixed or not', () => {
    const f = fixture(['en', 'hi']);
    f.send(greeting);
    f.say('मुझे नोट करिए', 'मुझे नोट करिए, can you say the number again?');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
    expect(f.turns()).toEqual(['मुझे नोट करिए, can you say the number again?']);
  });

  it('still barge in on Hinglish that shares words with German (das, der)', () => {
    const f = fixture(['en', 'hi']);
    f.send(greeting);
    f.say('Das tarikh ko', 'Das tarikh ko de dunga, thodi der lagegi');
    expect(f.of('turn.reset')).toEqual([]);
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
    expect(f.turns()).toEqual(['Das tarikh ko de dunga, thodi der lagegi']);
  });

  it('are a turn in silence, for the agent to ask the caller to repeat', () => {
    const f = fixture(['en', 'hi']);
    f.say('Ik lieg', 'Ik lieg niet.');
    expect(f.turns()).toEqual(['Ik lieg niet.']);
  });

  it('barge in as before for a detector without languages', () => {
    const f = fixture();
    f.send(greeting);
    f.say('Знаете, что?', 'Нет, это всё.');
    expect(f.of('interrupt')).toEqual([{ type: 'interrupt', reason: 'transcript' }]);
  });

  it('accepts base codes only', () => {
    expect(DetectorConfigSchema.safeParse({ languages: ['en', 'hi'] }).success).toBe(true);
    expect(DetectorConfigSchema.safeParse({ languages: ['en-IN'] }).success).toBe(false);
    expect(DetectorConfigSchema.safeParse({ languages: [] }).success).toBe(false);
  });
});
