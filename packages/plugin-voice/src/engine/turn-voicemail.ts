import type { Behavior, SessionInput } from '@winsendotai/ovo-contracts';
import type { BoundedSpeechScheduler } from '../scheduler.ts';

/**
 * An answering machine picked up. Whatever is playing or being composed is cut off, the
 * behaviour's message (if it has one) is left on the machine, and the call ends as `voicemail`.
 * Returns the task leaving the message, or undefined when the behaviour does not handle voicemail:
 * the call then stays exactly as it is.
 */
export function leaveVoicemail(input: {
  behavior: Behavior;
  session: SessionInput;
  speech: BoundedSpeechScheduler;
  /** Stops the running turn; nothing new starts after it. */
  cutOff: () => void;
  /** Resolves once a barge-in in progress has flushed. */
  settled: () => Promise<unknown>;
  stopped: () => boolean;
  end: (detail: string) => void;
  failed: (error: unknown) => void;
}): Promise<void> | undefined {
  const { speech } = input;
  let text: string | undefined;
  let detail: string;
  try {
    text = input.behavior.voicemail?.(structuredClone(input.session.variables))?.trim();
    detail = `voicemail:${text ? 'message' : 'hangup'}`;
  } catch (error) {
    // A message that cannot render is not left, but the machine still gets no conversation.
    input.failed(error);
    text = '';
    detail = 'voicemail:message-failed';
  }
  if (text === undefined) return undefined;
  input.cutOff();
  const message = text;
  return (async () => {
    await input.settled();
    const epoch = await speech.beginEpoch();
    if (input.stopped() || !message) return;
    await speech.speak(message, { epoch, kind: 'response' });
  })().then(
    () => input.end(detail),
    (error: unknown) => {
      input.failed(error);
      input.end('voicemail:message-failed');
    },
  );
}
