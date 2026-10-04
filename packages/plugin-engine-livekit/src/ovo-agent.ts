import { Agent, voice, type llm } from '@livekit/agents';
import type { TurnDriver } from './turn-driver.ts';

export class OvoAgent extends Agent {
  constructor(private readonly driver: TurnDriver) {
    super({ instructions: 'All responses and tools belong to OVO Behavior.' });
  }
  override async onUserTurnCompleted(
    _ctx: llm.ChatContext,
    message: llm.ChatMessage,
  ): Promise<void> {
    this.driver.enqueue(message.textContent ?? '');
    // Never await the driver or playout here: LiveKit still owns the speech scheduling turn.
    throw new voice.StopResponse();
  }
}
