import { describe, expect, it } from 'vitest';
import { humanQueueOperationsConfig } from './human-queue-config.ts';

describe('humanQueueOperationsConfig', () => {
  it('enables the sweeper only for exactly true', () => {
    expect(humanQueueOperationsConfig({ OVO_HUMAN_QUEUE_ENABLED: 'true' }).humanQueueEnabled).toBe(
      true,
    );
    for (const value of [undefined, '', 'false', 'TRUE', '1'])
      expect(humanQueueOperationsConfig({ OVO_HUMAN_QUEUE_ENABLED: value }).humanQueueEnabled).toBe(
        false,
      );
  });

  it('reads the presence TTL only inside 10 to 300 whole seconds (Compose renders unset as empty)', () => {
    const ttl = (value: string | undefined) =>
      humanQueueOperationsConfig({ OVO_HUMAN_QUEUE_PRESENCE_TTL_SECONDS: value });
    expect(ttl('45')).toEqual({ humanQueueEnabled: false, humanQueuePresenceTtlSeconds: 45 });
    for (const value of [undefined, '', '9', '301', '1.5', 'abc'])
      expect(ttl(value)).toEqual({ humanQueueEnabled: false });
  });
});
