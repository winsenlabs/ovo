import type { AgentConfig } from '@winsendotai/ovo-contracts';
import {
  BoundedByteCache,
  type ByteCache,
  type ByteCacheLimits,
} from '@winsendotai/ovo-plugin-cache';
import type { ApprovedSpeechPhrase } from '@winsendotai/ovo-plugin-speech-cache';

export const HYBRID_SPEECH_CACHE_PLUGIN_ID = '@winsendotai/ovo-worker/hybrid-speech-cache-output';

/** Owns the bounded process cache shared by selected v2 speech output plugins. */
export class WorkerSpeechCacheRuntime {
  readonly cache: ByteCache;

  constructor(limits: ByteCacheLimits = {}) {
    this.cache = new BoundedByteCache(limits);
  }

  close(): void {
    this.cache.clear();
  }
}

export function approvedSpeechPhrases(agent: AgentConfig): ApprovedSpeechPhrase[] {
  const policy = agent.speechCache;
  if (!policy?.enabled) return [];
  const phrases = new Map<string, ApprovedSpeechPhrase>();
  const approveStatic = (text: string | undefined) => {
    if (text?.trim()) phrases.set(`static:${text}`, { text, purpose: 'static-phrase' });
  };
  approveStatic(agent.processing.initial);
  approveStatic(agent.processing.progress);
  for (const tool of agent.tools) {
    approveStatic(tool.processing?.initial);
    approveStatic(tool.processing?.progress);
  }
  if (policy.announcement && agent.mode === 'announcement' && agent.message.trim())
    phrases.set(`announcement:${agent.message}`, {
      text: agent.message,
      purpose: 'announcement',
    });
  return [...phrases.values()];
}
