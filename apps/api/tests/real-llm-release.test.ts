import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Cap } from '@winsendotai/ovo-contracts';
import { loadDistribution } from '@winsendotai/ovo-distribution';
import type { ReleaseRecord } from '@winsendotai/ovo-plugin-storage';
import { compose } from '@winsendotai/ovo-runtime';
import { expect, it, vi } from 'vitest';
import { composeLiveSessionGraph } from '../../worker/src/session-graph-runtime.ts';
import { buildManagementApi } from '../src/server.ts';

const llm = '@winsendotai/ovo-provider-openai-inference';
const tts = '@winsendotai/ovo-provider-openai-tts';
const stt = '@winsendotai/ovo-provider-deepgram-stt';

it.each(['context', 'agent'] as const)(
  'publishes a %s release with the real OpenAI LLM when the worker composes it',
  async (mode) => {
    const directory = await mkdtemp('/var/tmp/ovo-real-llm-');
    const distribution = await loadDistribution({ role: 'api', profile: 'compose', env: {} });
    const workerDistribution = await loadDistribution({
      role: 'worker',
      profile: 'compose',
      env: {
        DATABASE_URL: 'postgres://unused:unused@127.0.0.1/unused',
        OVO_QUEUE_URL: 'http://127.0.0.1/unused',
        AWS_REGION: 'us-east-1',
      },
    });
    const { app, composition } = await buildManagementApi({
      databaseFile: join(directory, 'control.sqlite'),
      loadedDistribution: distribution,
      secretsMasterKey: Buffer.alloc(32, 5).toString('base64'),
      sessionSecret: 'real-llm-test-session',
      identities: [
        {
          id: 'operator',
          label: 'Operator',
          token: 'operator-token',
          defaultWorkspaceId: 'w',
          workspaces: { w: 'admin' },
        },
      ],
    });
    const parent = await compose([], []);
    const headers = { authorization: 'Bearer operator-token' };
    const post = (url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers, payload });
    try {
      const binding = async (provider: string, pluginId: string, config: object) => {
        const credential = await post('/v1/credentials', {
          label: `${provider} credential`,
          provider,
          type: 'api-key',
          environment: 'test',
          value: 'test-key',
        });
        expect(credential.statusCode, credential.body).toBe(201);
        const result = await post('/v1/provider-bindings', {
          label: `${provider} binding`,
          provider,
          pluginId,
          environment: 'test',
          credentialId: credential.json().id,
          config,
        });
        expect(result.statusCode, result.body).toBe(201);
        return result.json().id as string;
      };
      const llmBinding = await binding('openai', llm, { model: 'gpt-4o-mini' });
      const ttsBinding = await binding('openai', tts, { model: 'tts-1', voice: 'alloy' });
      const sttBinding = await binding('deepgram', stt, { model: 'nova-2' });
      const agent = await post('/v1/agents', {
        config: {
          name: `Real ${mode}`,
          mode,
          context: 'Reference facts.',
          recording: false,
          providers: {},
          voice: {
            engine: { plugin: '@winsendotai/ovo-plugin-voice-session-engine', config: {} },
            llm: { plugin: llm, binding: llmBinding, config: {} },
            tts: { plugin: tts, binding: ttsBinding, config: {} },
            stt: { plugin: stt, binding: sttBinding, config: {} },
          },
        },
      });
      expect(agent.statusCode, agent.body).toBe(201);
      const released = await post(`/v1/agents/${agent.json().id}/releases`, {});
      expect(released.statusCode, released.body).toBe(201);
      const release = released.json() as ReleaseRecord;
      expect(release.selections?.llm?.pluginId).toBe(llm);
      const marks = new Set<(name: string) => void>();
      const graph = await composeLiveSessionGraph({
        graph: { distribution: workerDistribution, parent },
        release,
        routeSessionId: 'session-real-llm',
        variables: {},
        media: {
          sessionId: 'session-real-llm',
          bufferedBytes: 0,
          sendAudio: vi.fn(async () => undefined),
          sendMark: vi.fn(async (name: string) => {
            for (const listener of marks) listener(name);
          }),
          clear: vi.fn(async () => undefined),
          close: vi.fn(async () => undefined),
          onAudio: () => () => undefined,
          onMark: (listener: (name: string) => void) => {
            marks.add(listener);
            return () => marks.delete(listener);
          },
          onDtmf: () => () => undefined,
          onClose: () => () => undefined,
        } as never,
        operationStore: {} as never,
        secrets: { resolve: async () => 'test-key' },
        telemetry: {
          providerUsage: vi.fn(),
          audit: vi.fn(),
          adapter: { speech: vi.fn() },
          startStage: () => () => true,
        } as never,
        extensions: { plugins: [], nativeHandlers: {} },
        carrierMedia: {
          carrierId: 'twilio',
          playbackEvidence: 'carrier-played',
          clearFlushesMarkers: true,
        },
      });
      expect(graph.composition.ctx.get(Cap.inference)).toBeDefined();
      await graph.composition.dispose();
    } finally {
      await parent.dispose();
      await composition.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
