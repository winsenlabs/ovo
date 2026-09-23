export type DistributionRole = 'api' | 'worker' | 'gateway' | 'dispatcher';
export interface CatalogEntry {
  package: string;
  roles: readonly (DistributionRole | 'session')[];
  load: () => Promise<unknown>;
}

/** Installed first-party packages, including wave-2 skeletons and frozen future subpaths. */
export const FIRST_PARTY: readonly CatalogEntry[] = [
  {
    package: '@winsendotai/ovo-behaviors',
    roles: ['session', 'api'],
    load: async () => ({
      plugins: (await import('@winsendotai/ovo-behaviors')).createBehaviorPluginCatalog(),
    }),
  },
  {
    package: '@winsendotai/ovo-plugin-voice',
    roles: ['session', 'api'],
    load: async () => {
      const voice = await import('@winsendotai/ovo-plugin-voice');
      return {
        plugins: [
          voice.createVoiceSessionEnginePlugin(),
          voice.createSpeechSchedulerPlugin(),
          voice.createStreamingMediaSpeechOutputPlugin(),
        ],
      };
    },
  },
  {
    package: '@winsendotai/ovo-plugin-turns',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-turns'),
  },
  {
    package: '@winsendotai/ovo-plugin-vad',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-vad'),
  },
  {
    package: '@winsendotai/ovo-plugin-engine-livekit',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-engine-livekit'),
  },
  {
    package: '@winsendotai/ovo-plugin-stt-deepgram',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-stt-deepgram'),
  },
  {
    package: '@winsendotai/ovo-plugin-tts-openai',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-tts-openai'),
  },
  {
    package: '@winsendotai/ovo-plugin-llm-openai',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-llm-openai'),
  },
  {
    package: '@winsendotai/ovo-plugin-stt-assemblyai',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-stt-assemblyai'),
  },
  {
    package: '@winsendotai/ovo-plugin-speech-sarvam',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-speech-sarvam'),
  },
  {
    package: '@winsendotai/ovo-plugin-carrier-twilio',
    roles: ['api', 'worker', 'gateway', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-carrier-twilio'),
  },
  {
    package: '@winsendotai/ovo-plugin-carrier-exotel',
    roles: ['api', 'worker', 'gateway', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-carrier-exotel'),
  },
  {
    package: '@winsendotai/ovo-plugin-carrier-plivo',
    roles: ['api', 'worker', 'gateway', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-carrier-plivo'),
  },
  {
    package: '@winsendotai/ovo-fixture-calls',
    roles: ['api'],
    load: () => import('@winsendotai/ovo-fixture-calls'),
  },
  {
    package: '@winsendotai/ovo-plugin-operations/background-tasks',
    roles: ['dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-operations/background-tasks'),
  },
  {
    package: '@winsendotai/ovo-plugin-ledger/background-tasks',
    roles: ['dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-ledger/background-tasks'),
  },
  {
    package: '@winsendotai/ovo-plugin-orchestration/background-tasks',
    roles: ['dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-orchestration/background-tasks'),
  },
  {
    package: '@winsendotai/ovo-plugin-orchestration/capacity-signals',
    roles: ['dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-orchestration/capacity-signals'),
  },
  {
    package: '@winsendotai/ovo-plugin-cache',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-cache'),
  },
  {
    package: '@winsendotai/ovo-plugin-speech-cache',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-speech-cache'),
  },
  {
    package: '@winsendotai/ovo-plugin-inference',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-inference'),
  },
  {
    package: '@winsendotai/ovo-plugin-tools',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-tools'),
  },
  {
    package: '@winsendotai/ovo-plugin-tools-http',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-tools-http'),
  },
  {
    package: '@winsendotai/ovo-plugin-tools-mcp',
    roles: ['session'],
    load: () => import('@winsendotai/ovo-plugin-tools-mcp'),
  },
  {
    package: '@winsendotai/ovo-plugin-storage',
    roles: ['api', 'worker'],
    load: async () => ({
      plugins: [(await import('@winsendotai/ovo-plugin-storage')).storagePlugin],
    }),
  },
  {
    package: '@winsendotai/ovo-plugin-secrets',
    roles: ['api', 'worker'],
    load: async () => ({
      plugins: [(await import('@winsendotai/ovo-plugin-secrets')).secretsPlugin],
    }),
  },
  {
    package: '@winsendotai/ovo-plugin-observability',
    roles: ['api', 'worker'],
    load: async () => ({
      plugins: [(await import('@winsendotai/ovo-plugin-observability')).observabilityPlugin],
    }),
  },
  {
    package: '@winsendotai/ovo-plugin-recordings',
    roles: ['api', 'worker'],
    load: async () => ({
      plugins: [(await import('@winsendotai/ovo-plugin-recordings')).recordingsPlugin],
    }),
  },
  {
    package: '@winsendotai/ovo-plugin-orchestration',
    roles: ['worker', 'dispatcher'],
    load: async () => {
      const orchestration = await import('@winsendotai/ovo-plugin-orchestration');
      return {
        plugins: [orchestration.postgresOrchestrationPlugin, orchestration.sqsOrchestrationPlugin],
      };
    },
  },
  {
    package: '@winsendotai/ovo-plugin-operations',
    roles: ['api', 'worker', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-operations'),
  },
  {
    package: '@winsendotai/ovo-plugin-ledger',
    roles: ['api', 'worker', 'dispatcher'],
    load: () => import('@winsendotai/ovo-plugin-ledger'),
  },
  {
    package: '@winsendotai/ovo-plugin-media',
    roles: ['worker', 'gateway'],
    load: () => import('@winsendotai/ovo-plugin-media'),
  },
  {
    package: '@winsendotai/ovo-plugin-evaluations',
    roles: ['api'],
    load: () => import('@winsendotai/ovo-plugin-evaluations'),
  },
];
