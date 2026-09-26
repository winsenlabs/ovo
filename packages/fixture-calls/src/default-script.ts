import type { AgentConfig, Clock, EngineEvent } from '@winsendotai/ovo-contracts';
import type { CallerScript } from './types.ts';

export function defaultCallerScript(config: AgentConfig): CallerScript {
  if (config.mode === 'announcement') return { turns: [] };
  if (config.mode === 'faq') {
    const [first, second] = config.faq;
    return {
      turns: [
        { atMs: 0, say: first?.question ?? 'What can you help me with?' },
        { atMs: 1200, say: second?.question ?? 'Can you say that again?' },
      ],
    };
  }
  if (config.mode === 'agent')
    return {
      turns: [
        { atMs: 0, say: 'Please do that.' },
        { atMs: 1200, say: 'yes' },
      ],
    };
  return { turns: [{ atMs: 0, say: 'Can you help me?' }] };
}

export function predictedAgentTexts(config: AgentConfig): string[] {
  const texts =
    config.mode === 'announcement'
      ? [config.message]
      : config.mode === 'faq'
        ? [config.faq[0]?.answer, config.faq[1]?.answer ?? config.clarification]
        : config.mode === 'context'
          ? ['All done.']
          : [config.processing.initial, 'All done.'];
  return [...new Set(texts.filter(Boolean))];
}

/** A default write confirmation is spoken only after the prompt has finished playback. */
export function callerPlayback(input: {
  clock: Clock;
  script: CallerScript;
  reactiveConfirmation: boolean;
  say(text: string, turnIndex: number): void;
  dtmf(digit: string): void;
  hangup(): void;
}) {
  const cancels: (() => void)[] = [];
  let confirmed = false;
  return {
    start() {
      for (const [turnIndex, turn] of input.script.turns.entries()) {
        if (input.reactiveConfirmation && turn.say === 'yes') continue;
        cancels.push(
          input.clock.setTimeout(() => {
            if (turn.say) input.say(turn.say, turnIndex);
            if (turn.dtmf) for (const digit of turn.dtmf) input.dtmf(digit);
          }, turn.atMs),
        );
      }
      const last = Math.max(
        0,
        ...input.script.turns.map((turn) => turn.atMs + (turn.silenceMs ?? 0)),
      );
      cancels.push(
        input.clock.setTimeout(
          input.hangup,
          input.reactiveConfirmation ? Math.max(last + 5000, 110_000) : last + 5000,
        ),
      );
    },
    onEvent(event: EngineEvent) {
      if (
        !input.reactiveConfirmation ||
        confirmed ||
        event.type !== 'agent.transcript' ||
        event.state !== 'played' ||
        !event.text.startsWith('Please confirm: ') ||
        !event.text.endsWith('Say yes to proceed or no to cancel.')
      )
        return;
      confirmed = true;
      const turnIndex = input.script.turns.findIndex((turn) => turn.say === 'yes');
      if (turnIndex >= 0)
        cancels.push(input.clock.setTimeout(() => input.say('yes', turnIndex), 0));
    },
    cancel() {
      for (const cancel of cancels) cancel();
    },
  };
}
