import type {
  Clock,
  NetFixtureScript,
  NetFixtureStep,
  NetPort,
  WebSocketLike,
} from '@winsendotai/ovo-contracts';
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

function httpSpeechText(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    return typeof row.input === 'string'
      ? row.input
      : typeof row.text === 'string'
        ? row.text
        : undefined;
  } catch {
    return undefined;
  }
}

function socketSpeechText(data: string | Uint8Array): string | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const row = parsed as Record<string, unknown>;
    const nested = row.data;
    if (row.type !== 'text' || !nested || typeof nested !== 'object' || Array.isArray(nested))
      return undefined;
    const text = (nested as Record<string, unknown>).text;
    return typeof text === 'string' ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the vendor's wire script strict; only the text field is supplied by a sentence-sized request. */
function sentenceSocketScripts(scripts: NetFixtureScript[], fullText: string): NetFixtureScript[] {
  return scripts.map((script) => ({
    ...script,
    steps: script.steps.map((step) => {
      if (!('expect' in step) || step.expect !== 'ws-send' || step.match !== 'json') return step;
      const data = step.where?.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) return step;
      const fields = data as Record<string, unknown>;
      if (fields.text !== fullText) return step;
      const { data: _data, ...where } = step.where ?? {};
      return {
        ...step,
        where: {
          ...where,
          ...Object.fromEntries(
            Object.entries(fields)
              .filter(([key]) => key !== 'text')
              .map(([key, value]) => [`data.${key}`, value]),
          ),
          'data.text': /^.+$/,
        },
      };
    }),
  }));
}

/** Render selected TTS scripts when the engine makes a synthesis request, using its generated text. */
export function deferredTtsNet(
  scripts: readonly NetFixtureScript[],
  ttsTemplate: ((text: string) => NetFixtureScript[]) | undefined,
  clock: Clock,
  sttPlan?: SttReplayPlan,
): NetPort & {
  generated(text: string, segmentId?: string): void;
  played(segmentId: string): void;
  interrupted(segmentId: string): void;
  callerTurn(index: number): void;
  callerHangup(): void;
  assertComplete(): void;
} {
  const base = createFixtureNet(scripts, { clock });
  const stt = sttPlan ? createSttReplayNet(sttPlan, clock) : undefined;
  const generated: { segmentId?: string; text: string; remaining: string; claimed: boolean }[] = [];
  const activated: FixtureNet[] = [];
  const incompletePlayback: string[] = [];
  const candidates = (requested?: string) =>
    generated
      .filter((turn) => !turn.claimed && (!requested || turn.remaining.startsWith(requested)))
      .map((turn) => {
        const rendered = ttsTemplate?.(requested ?? turn.remaining) ?? [];
        return { turn, rendered, first: firstNetworkStep(rendered) };
      });
  const consume = (turn: (typeof generated)[number], text: string) => {
    if (!text || !turn.remaining.startsWith(text))
      throw new FixtureMismatchError('TTS', 'a prefix of generated speech', text);
    turn.remaining = turn.remaining.slice(text.length).trimStart();
    turn.claimed = false;
    if (!turn.remaining) generated.splice(generated.indexOf(turn), 1);
  };
  const activate = (net: FixtureNet) => {
    activated.push(net);
  };
  return {
    callerHangup() {
      stt?.callerHangup();
    },
    callerTurn(index) {
      stt?.release(index);
    },
    generated(text, segmentId?: string) {
      if (ttsTemplate) generated.push({ segmentId, text, remaining: text, claimed: false });
    },
    played(segmentId) {
      const turn = generated.find((row) => row.segmentId === segmentId);
      if (turn?.remaining)
        incompletePlayback.push(`played ${segmentId} before TTS synthesized: ${turn.remaining}`);
    },
    interrupted(segmentId) {
      const at = generated.findIndex((row) => row.segmentId === segmentId);
      if (at >= 0) generated.splice(at, 1);
    },
    async fetch(url, init = {}) {
      const normalizedUrl = new URL(url).href;
      const method = (init.method ?? 'GET').toUpperCase();
      // Read once: a streaming request body cannot be replayed for each candidate.
      const body =
        init.body === undefined || init.body === null
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : await new Response(init.body).text();
      const requested = httpSpeechText(body);
      const matching = candidates(requested).filter(({ first }) =>
        first.some(
          (step) =>
            step.expect === 'http' &&
            step.method.toUpperCase() === method &&
            matchesUrl(step.url, normalizedUrl),
        ),
      );
      if (!matching.length) return base.fetch(url, { ...init, body });
      let mismatch: FixtureMismatchError | undefined;
      for (const candidate of matching) {
        candidate.turn.claimed = true;
        const net = createFixtureNet(candidate.rendered, { clock });
        try {
          const response = await net.fetch(url, { ...init, body });
          activate(net);
          consume(candidate.turn, requested ?? candidate.turn.remaining);
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
      // LiveKit can open the next sentence socket before the prior socket sends its text.
      // Reserve the actual prefix at the text frame, not at socket open.
      const net = createFixtureNet(
        sentenceSocketScripts(candidate.rendered, candidate.turn.remaining),
        { clock },
      );
      const socket = net.websocket(url, opts);
      activate(net);
      const wrapped: WebSocketLike = {
        get readyState() {
          return socket.readyState;
        },
        on: socket.on.bind(socket),
        close: socket.close.bind(socket),
        send(data) {
          const text = socketSpeechText(data);
          if (text !== undefined && (!text || !candidate.turn.remaining.startsWith(text)))
            throw new FixtureMismatchError('TTS', 'a prefix of generated speech', text);
          socket.send(data);
          if (text !== undefined) consume(candidate.turn, text);
        },
      };
      return wrapped;
    },
    assertComplete() {
      base.assertComplete();
      stt?.assertComplete();
      for (const net of activated) net.assertComplete();
      if (incompletePlayback.length) throw FixtureMismatchError.incomplete(incompletePlayback);
    },
  };
}
