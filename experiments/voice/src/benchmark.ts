import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose } from '@winsendotai/ovo-runtime';
import {
  createFocusedOvoCompositionSpec,
  createLiveKitCompositionSpec,
  expectExperimentService,
  VOICE_EXPERIMENT_SERVICE,
  type ExperimentCompositionSpec,
  type ScenarioResult,
} from './index.ts';
import { captureSourceIdentity } from './evidence.ts';

interface RawSample {
  index: number;
  durationMs: number;
  ok: boolean;
  observation?: Pick<
    ScenarioResult,
    'modelRequests' | 'toolAttempts' | 'toolOwner' | 'stalePlaybackCount' | 'operationState'
  >;
  failure?: { name: string; message: string };
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(packageRoot, '../..');
const faqSamples = positiveInt(process.env.OVO_FAQ_SAMPLES, 30);
const toolSamples = positiveInt(process.env.OVO_TOOL_SAMPLES, 10);
const coldSamples = positiveInt(process.env.OVO_COLD_SAMPLES, 10);
const warmups = positiveInt(process.env.OVO_BENCHMARK_WARMUPS, 3);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 1_000 ? parsed : fallback;
}

function observation(result: ScenarioResult): RawSample['observation'] {
  return {
    modelRequests: result.modelRequests,
    toolAttempts: result.toolAttempts,
    toolOwner: result.toolOwner,
    stalePlaybackCount: result.stalePlaybackCount,
    ...(result.operationState === undefined ? {} : { operationState: result.operationState }),
  };
}

async function measure(count: number, run: () => Promise<ScenarioResult>): Promise<RawSample[]> {
  const samples: RawSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    try {
      const result = await run();
      samples.push({
        index,
        durationMs: Number((performance.now() - started).toFixed(3)),
        ok: true,
        observation: observation(result),
      });
    } catch (error) {
      samples.push(failedSample(index, performance.now() - started, error));
    }
  }
  return samples;
}

async function measureCold(
  count: number,
  createSpec: () => ExperimentCompositionSpec,
): Promise<RawSample[]> {
  const samples: RawSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    let composition: Awaited<ReturnType<typeof compose>> | undefined;
    try {
      const spec = createSpec();
      composition = await compose(spec.rows, spec.catalog);
      const engine = expectExperimentService(composition.ctx.get(VOICE_EXPERIMENT_SERVICE));
      const result = await engine.runFaq();
      await composition.dispose();
      composition = undefined;
      samples.push({
        index,
        durationMs: Number((performance.now() - started).toFixed(3)),
        ok: true,
        observation: observation(result),
      });
    } catch (error) {
      if (composition) await composition.dispose().catch(() => undefined);
      samples.push(failedSample(index, performance.now() - started, error));
    }
  }
  return samples;
}

function failedSample(index: number, durationMs: number, error: unknown): RawSample {
  return {
    index,
    durationMs: Number(durationMs.toFixed(3)),
    ok: false,
    failure: {
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

async function benchmarkCandidate(createSpec: () => ExperimentCompositionSpec) {
  const spec = createSpec();
  const composition = await compose(spec.rows, spec.catalog);
  const engine = expectExperimentService(composition.ctx.get(VOICE_EXPERIMENT_SERVICE));
  let hot;
  try {
    for (let index = 0; index < warmups; index += 1) {
      await engine.runFaq();
      await engine.runInterruptToolScenario();
    }
    hot = {
      noLlmFaq: await measure(faqSamples, () => engine.runFaq()),
      interruptBeforeToolSettles: await measure(toolSamples, () =>
        engine.runInterruptToolScenario(),
      ),
    };
  } finally {
    await composition.dispose();
  }
  return {
    candidate: engine.candidate,
    samples: {
      hot,
      cold: { composeFaqDispose: await measureCold(coldSamples, createSpec) },
    },
  };
}

const createdAt = new Date().toISOString();
const sourceIdentity = await captureSourceIdentity(repositoryRoot);
const candidates = [];
for (const createSpec of [createFocusedOvoCompositionSpec, createLiveKitCompositionSpec]) {
  candidates.push(await benchmarkCandidate(createSpec));
}
const sourceIdentityAfter = await captureSourceIdentity(repositoryRoot);
if (JSON.stringify(sourceIdentity.sha256) !== JSON.stringify(sourceIdentityAfter.sha256)) {
  throw new Error(
    'source or lockfile changed during benchmark; refusing to write ambiguous evidence',
  );
}
const output = {
  schemaVersion: 2,
  createdAt,
  scope:
    'local deterministic text-only fixtures; no network, provider, local-model, audio, or carrier calls',
  protocol: {
    warmups,
    hotFaqSamplesPerCandidate: faqSamples,
    hotToolSamplesPerCandidate: toolSamples,
    coldLifecycleSamplesPerCandidate: coldSamples,
    hotPath: 'one long-lived composition and session per candidate; setup and disposal excluded',
    coldPath: 'new composition, one FAQ call, and disposal included in every sample',
    clock: 'performance.now()',
    intentBoundary:
      'focused operation records use an in-memory fixture store and are not durable evidence',
    livekitLocalInferenceModels: {
      enabled: false,
      controls: ['vad: null', 'turnDetection: null', 'no local-inference API import'],
      prohibition: 'do not extract model weights or use model outputs in focused OVO',
    },
  },
  sourceIdentity,
  versions: {
    livekitAgents: '1.9.0',
    livekitAgentsSource: '5287be114b12fb16f0a3eb6ccca4173e6e3eb219',
    vercelAi: '7.0.107',
    vercelAiSource: '20dd00abba618d5a516e0fee40ccd3e18a2bd1fb',
    transitiveLicenseNotice: {
      livekitLocalInference:
        '@livekit/local-inference@0.2.7: Apache-2.0 AND LicenseRef-LiveKit-Model',
      livekitPlatformAv: '@livekit/av-linux-x64@10.0.0: LGPL-2.1-or-later',
    },
  },
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    cpuCount: cpus().length,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtCapture: freemem(),
    ci: process.env.CI ?? null,
  },
  candidates,
};

const resultsDirectory = resolve(packageRoot, 'results');
await mkdir(resultsDirectory, { recursive: true });
const outputPath = resolve(
  resultsDirectory,
  `raw-${createdAt.replaceAll(':', '-').replaceAll('.', '-')}.json`,
);
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
process.stdout.write(`${outputPath}\n`);
