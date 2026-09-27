import { expect, it } from 'vitest';
import { MULAW_8K, type FixtureTemplate, type NetFixtureStep } from '@winsendotai/ovo-contracts';
import { FakeClock } from '@winsendotai/ovo-conformance/drivers';
import { planSttReplay } from '../src/stt-replay-plan.ts';
import { createSttReplayNet } from '../src/stt-replay-net.ts';

const url = 'wss://fixture.invalid/stt';
const input = {
  format: MULAW_8K,
  language: 'en',
  sessionId: 'cancel',
  turns: [{ atMs: 0, say: 'hello' }],
};
const normalTail: NetFixtureStep[] = [
  { expect: 'ws-send', match: 'json', where: { type: 'finish' } },
  { send: 'usage' },
  { close: { code: 1000 } },
];
function template(tail = normalTail, delayMs = 0): FixtureTemplate {
  return (value) => [
    {
      host: 'fixture.invalid',
      source: 'https://fixture.invalid/stt',
      retrieved: '2026-09-26',
      steps: [
        { expect: 'ws-open', url },
        { expect: 'ws-send', match: 'binary' },
        ...value.turns.flatMap((turn): NetFixtureStep[] =>
          turn.say ? [...(delayMs ? [{ delayMs }] : []), { send: turn.say }] : [],
        ),
        ...tail,
      ],
    },
  ];
}

for (const code of [undefined, 1000, 1005, 1006, 1011]) {
  it(`only allows a normal scripted caller cancellation (close code ${String(code)})`, async () => {
    const clock = new FakeClock();
    const replay = createSttReplayNet(planSttReplay(template(), input), clock);
    const socket = replay.port.websocket(url);
    const received: unknown[] = [];
    socket.on('message', (message) => received.push(message));
    await clock.advanceAsync(0);
    replay.release(0);
    socket.send(new Uint8Array(1));
    await clock.advanceAsync(0);
    expect(received).toEqual(['hello']);
    replay.callerHangup();
    socket.close(code);
    if (code === undefined || code === 1000) expect(() => replay.assertComplete()).not.toThrow();
    else expect(() => replay.assertComplete()).toThrow();
  });
}

it('does not authorize an unsolicited engine cancellation', async () => {
  const clock = new FakeClock();
  const replay = createSttReplayNet(planSttReplay(template(), input), clock);
  const socket = replay.port.websocket(url);
  socket.on('message', () => undefined);
  await clock.advanceAsync(0);
  replay.release(0);
  socket.send(new Uint8Array(1));
  await clock.advanceAsync(0);
  socket.close(1000);
  expect(() => replay.assertComplete()).toThrow();
});

it('keeps a prior wire mismatch fatal after an otherwise valid scripted cancellation', async () => {
  const clock = new FakeClock();
  const replay = createSttReplayNet(planSttReplay(template(), input), clock);
  const socket = replay.port.websocket(url);
  socket.on('message', () => undefined);
  await clock.advanceAsync(0);
  replay.release(0);
  socket.send(new Uint8Array(1));
  await clock.advanceAsync(0);
  expect(() => socket.send('wrong finish')).toThrow();
  replay.callerHangup();
  socket.close(1000);
  expect(() => replay.assertComplete()).toThrow();
});

it('does not confuse released caller audio with a delayed transcript that was never delivered', async () => {
  const clock = new FakeClock();
  const replay = createSttReplayNet(planSttReplay(template(normalTail, 50), input), clock);
  const socket = replay.port.websocket(url);
  const received: unknown[] = [];
  socket.on('message', (message) => received.push(message));
  await clock.advanceAsync(0);
  replay.release(0);
  socket.send(new Uint8Array(1));
  await clock.advanceAsync(0);
  expect(received).toEqual([]);
  replay.callerHangup();
  socket.close(1000);
  expect(() => replay.assertComplete()).toThrow();
});

for (const tail of [
  normalTail.slice(0, 2),
  [...normalTail, { send: 'after-close' }],
  [...normalTail, { close: { code: 1000 } }],
]) {
  it('does not exempt an incomplete or nonterminal shutdown tail', () => {
    const plan = planSttReplay(template(tail), input);
    expect(plan.shutdownStarts).toEqual([undefined]);
  });
}
