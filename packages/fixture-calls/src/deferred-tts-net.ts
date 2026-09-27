import type { Clock, NetFixtureScript, NetFixtureStep, NetPort } from '@winsendotai/ovo-contracts';
import {
  createFixtureNet,
  FixtureMismatchError,
  type FixtureNet,
} from '@winsendotai/ovo-plugin-kit';

import { createSttReplayNet } from './stt-replay-net.ts';
import type { SttReplayPlan } from './stt-replay-plan.ts';

type NetworkStep = Extract<NetFixtureStep, { expect: 'http' | 'ws-open' }>;

function firstNetworkStep(scripts: readonly NetFixtureScript[]): NetworkStep[] {
  return scripts.flatMap((script) => {
    const step = script.steps.find((item) => !('delayMs' in item));
    return step && 'expect' in step && (step.expect === 'http' || step.expect === 'ws-open')
      ? [step]
      : [];
  });
}

function matchesUrl(expected: string | RegExp, actual: string): boolean {
  if (typeof expected === 'string') return expected === actual;
  expected.lastIndex = 0;
  return expected.test(actual);
}

/** Render selected TTS scripts when the engine makes a synthesis request, using its generated text. */
export function deferredTtsNet(
  scripts: readonly NetFixtureScript[],
  ttsTemplate: ((text: string) => NetFixtureScript[]) | undefined,
  clock: Clock,
  sttPlan?: SttReplayPlan,
): NetPort & {
  generated(text: string): void;
  callerTurn(index: number): void;
  callerHangup(): void;
  assertComplete(): void;
} {
  const base = createFixtureNet(scripts, { clock });
  const stt = sttPlan ? createSttReplayNet(sttPlan, clock) : undefined;
  const generated: { text: string; claimed: boolean; rendered?: NetFixtureScript[] }[] = [];
  const activated: FixtureNet[] = [];
  const candidates = () =>
    generated
      .filter((turn) => !turn.claimed)
      .map((turn) => {
        const rendered = (turn.rendered ??= ttsTemplate?.(turn.text) ?? []);
        return { turn, rendered, first: firstNetworkStep(rendered) };
      });
  const activate = (turn: (typeof generated)[number], net: FixtureNet) => {
    generated.splice(generated.indexOf(turn), 1);
    activated.push(net);
  };
  return {
    callerHangup() {
      stt?.callerHangup();
    },
    callerTurn(index) {
      stt?.release(index);
    },
    generated(text) {
      if (ttsTemplate) generated.push({ text, claimed: false });
    },
    async fetch(url, init = {}) {
      const normalizedUrl = new URL(url).href;
      const method = (init.method ?? 'GET').toUpperCase();
      const matching = candidates().filter(({ first }) =>
        first.some(
          (step) =>
            step.expect === 'http' &&
            step.method.toUpperCase() === method &&
            matchesUrl(step.url, normalizedUrl),
        ),
      );
      if (!matching.length) return base.fetch(url, init);
      // A request body may be a one-shot stream. Decode it once for strict replay of each
      // generated candidate; FixtureNet performs the same body-to-text conversion.
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : await new Response(init.body).text();
      let mismatch: FixtureMismatchError | undefined;
      for (const candidate of matching) {
        candidate.turn.claimed = true;
        const net = createFixtureNet(candidate.rendered, { clock });
        try {
          const response = await net.fetch(url, { ...init, body });
          activate(candidate.turn, net);
          return response;
        } catch (error) {
          candidate.turn.claimed = false;
          if (!(error instanceof FixtureMismatchError)) throw error;
          mismatch = error;
        }
      }
      throw mismatch ?? new Error('Selected TTS fixture did not match the synthesis request');
    },
    websocket(url, opts) {
      if (stt?.matches(url)) return stt.port.websocket(url, opts);
      const normalizedUrl = new URL(url).href;
      const matching = candidates().filter(({ first }) =>
        first.some((step) => step.expect === 'ws-open' && matchesUrl(step.url, normalizedUrl)),
      );
      if (!matching.length) return base.websocket(url, opts);
      // Websocket input frames follow the open; use generated segment order, and let
      // FixtureNet check the selected script's subsequent frames exactly.
      const candidate = matching[0]!;
      candidate.turn.claimed = true;
      const net = createFixtureNet(candidate.rendered, { clock });
      try {
        const socket = net.websocket(url, opts);
        activate(candidate.turn, net);
        return socket;
      } catch (error) {
        candidate.turn.claimed = false;
        throw error;
      }
    },
    assertComplete() {
      base.assertComplete();
      stt?.assertComplete();
      for (const net of activated) net.assertComplete();
    },
  };
}
