import type { Behavior } from '@winsendotai/ovo-contracts';
import { raceAbort } from '../async.ts';

/**
 * Hands each line of the behaviour's reply to `say` as it is produced, until the reply ends, the
 * turn is aborted, or `current()` turns false (the call stopped, or a newer epoch began). `first`
 * runs just before the first line. An abandoned stream is closed afterwards, best effort.
 */
export async function speakReply(input: {
  behavior: Behavior;
  text: string;
  variables: Record<string, unknown>;
  signal: AbortSignal;
  current: () => boolean;
  first: () => void;
  say: (line: string) => void;
}): Promise<void> {
  const { behavior, signal } = input;
  let first = true;
  const line = (text: string) => {
    if (!text.trim()) return;
    if (first) input.first();
    first = false;
    input.say(text);
  };
  if (!behavior.respondStream) {
    const text = await raceAbort(behavior.respond(input.text, input.variables), signal);
    if (input.current()) line(text);
    return;
  }
  const iterator = behavior.respondStream(input.text, input.variables)[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const next = await raceAbort(iterator.next(), signal);
      if (next.done || !input.current()) break;
      line(next.value);
    }
  } finally {
    void Promise.resolve()
      .then(() => iterator.return?.())
      // swallow-ok: closing an abandoned behavior iterator is best-effort cleanup.
      .catch(() => undefined);
  }
}
