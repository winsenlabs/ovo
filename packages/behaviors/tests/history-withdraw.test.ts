import { expect, it } from 'vitest';
import { PlaybackConversation } from '../src/history.ts';

it('forgets a superseded turn so the merged turn is the only record of its words (AGT-10)', () => {
  const conversation = new PlaybackConversation();
  conversation.beginTurn(1);
  conversation.user('I want to pay');
  conversation.generated('Sure, when would you like to pay?');
  // Superseded during the LLM/TTS wait: nothing of the reply was heard.
  conversation.withdraw('I want to pay');
  conversation.beginTurn(2);
  expect(conversation.user('I want to pay tomorrow')).toEqual([]);
  expect(conversation.user('next')).toEqual([{ role: 'user', content: 'I want to pay tomorrow' }]);
});
