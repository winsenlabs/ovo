import { definePlugin } from '@winsendotai/ovo-runtime';
import { isAbsolute } from 'node:path';
import type { RecordingMediaTransport, PlaybackEvidenceSource } from './capture.ts';
import { LiveRecordingCapture } from './capture.ts';
import type { ExportInputLoader } from './exports.ts';
import { RecordingExportService } from './exports.ts';
import {
  RecordingBackgroundWorker,
  type RecordingBackgroundWorkerConfig,
} from './background-worker.ts';
import { LiveRecordingService } from './live-service.ts';
import { LocalRecordingBackend, S3RecordingBackend, type ObjectBackend } from './backend.ts';
import { PostgresRecordingRepository } from './postgres/index.ts';
import { RecordingRetentionService } from './retention.ts';
import { PRODUCTION_RECORDINGS_CONFIG_SCHEMA, type ProductionRecordingsConfig } from './config.ts';
import type { RecordingRepository } from './repository.ts';

export const RECORDING_SERVICE_KEYS = Object.freeze({
  live: 'ovo.recordings-live',
  retention: 'ovo.recording-retention',
  exports: 'ovo.recording-exports',
  production: 'ovo.recordings-production',
  media: 'ovo.media.duplex',
  session: 'ovo.recording-session',
});

export const RECORDING_PLUGIN_IDS = Object.freeze({
  production: '@winsendotai/ovo-plugin-recordings-production',
  capture: '@winsendotai/ovo-plugin-recording-capture',
});

type ProductionObjectConfig =
  | {
      kind: 's3';
      bucket: string;
      region?: string;
      endpoint?: string;
      forcePathStyle?: boolean;
      tls?: boolean;
    }
  | {
      kind: 'filesystem';
      directory: string;
      durableMounted: true;
      sharedMultiWorker: true;
    };

export interface ProductionRecordingServices {
  repository: RecordingRepository;
  live: LiveRecordingService;
  retention: RecordingRetentionService;
  exports: RecordingExportService;
  worker: RecordingBackgroundWorker;
}

export function createProductionRecordingsPlugin(
  input: ProductionRecordingsConfig,
  dependencies: {
    loadExportInput: ExportInputLoader;
    background?: RecordingBackgroundWorkerConfig;
  },
) {
  const config = PRODUCTION_RECORDINGS_CONFIG_SCHEMA.parse(structuredClone(input));
  const databaseUrl = config.databaseUrl;
  const objectStore = objectConfig(config);
  const loadExportInput = dependencies.loadExportInput;
  validateProductionObjectConfig(objectStore);
  return definePlugin(
    {
      id: RECORDING_PLUGIN_IDS.production,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'process',
      requires: [],
      provides: [
        RECORDING_SERVICE_KEYS.live,
        RECORDING_SERVICE_KEYS.retention,
        RECORDING_SERVICE_KEYS.exports,
        RECORDING_SERVICE_KEYS.production,
      ],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const repository = new PostgresRecordingRepository({
        connectionString: databaseUrl,
        max: 2,
      });
      let objects: ObjectBackend | undefined;
      let worker: RecordingBackgroundWorker | undefined;
      let exportService: RecordingExportService | undefined;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await worker?.stop();
          await exportService?.drain();
          objects?.close();
        } finally {
          await repository.close();
        }
      };
      ctx.effect(() => close);
      try {
        await repository.migrate();
        objects = productionBackend(objectStore);
        const live = new LiveRecordingService(repository, objects);
        const retention = new RecordingRetentionService(repository, objects);
        const exports = new RecordingExportService(repository, objects, loadExportInput);
        exportService = exports;
        worker = new RecordingBackgroundWorker(exports, retention, dependencies.background);
        ctx.provide(RECORDING_SERVICE_KEYS.live, live);
        ctx.provide(RECORDING_SERVICE_KEYS.retention, retention);
        ctx.provide(RECORDING_SERVICE_KEYS.exports, exports);
        ctx.provide(RECORDING_SERVICE_KEYS.production, {
          repository,
          live,
          retention,
          exports,
          worker,
        } satisfies ProductionRecordingServices);
        worker.start();
      } catch (error) {
        await close();
        throw error;
      }
    },
  );
}

function objectConfig(config: ProductionRecordingsConfig): ProductionObjectConfig {
  return config.backend === 's3'
    ? {
        kind: 's3',
        bucket: config.bucket!,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
      }
    : {
        kind: 'filesystem',
        directory: config.directory!,
        durableMounted: true,
        sharedMultiWorker: true,
      };
}

export function createRecordingCapturePlugin(options: {
  media: RecordingMediaTransport;
  workspaceId: string;
  callId: string;
  retentionDays: number;
  segmentBytes?: number;
  maxQueuedBytes?: number;
  evidence?: PlaybackEvidenceSource;
}) {
  const config = Object.freeze({ ...options });
  return definePlugin(
    {
      id: RECORDING_PLUGIN_IDS.capture,
      version: '0.1.0',
      contractVersion: 1,
      scope: 'session',
      requires: [RECORDING_SERVICE_KEYS.live],
      provides: [RECORDING_SERVICE_KEYS.media, RECORDING_SERVICE_KEYS.session],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    async (ctx) => {
      const live = ctx.get(RECORDING_SERVICE_KEYS.live) as LiveRecordingService | undefined;
      if (!live) throw new Error(`Missing ${RECORDING_SERVICE_KEYS.live}`);
      const capture = await LiveRecordingCapture.start({ service: live, ...config });
      ctx.provide(RECORDING_SERVICE_KEYS.media, capture);
      ctx.provide(RECORDING_SERVICE_KEYS.session, capture);
      ctx.effect(() => () => capture.finish());
    },
  );
}

function productionBackend(config: ProductionObjectConfig): ObjectBackend {
  if (config.kind === 's3') {
    return new S3RecordingBackend(config.bucket, {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      tls: config.tls,
    });
  }
  if (!config.durableMounted || !config.sharedMultiWorker)
    throw new Error(
      'Production filesystem recording backend must be durable and shared by all workers',
    );
  return new LocalRecordingBackend(config.directory);
}

export function validateProductionObjectConfig(config: ProductionObjectConfig): void {
  if (config.kind === 'filesystem') {
    if (!config.durableMounted || !config.sharedMultiWorker)
      throw new Error(
        'Production filesystem recording backend must be durable and shared by all workers',
      );
    if (!isAbsolute(config.directory))
      throw new Error('Production filesystem recording directory must be absolute');
  }
  if (config.kind === 's3') {
    if (config.bucket.length < 3 || config.bucket.length > 255)
      throw new Error('Invalid recording object bucket');
    const backend = new S3RecordingBackend(config.bucket, {
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      tls: config.tls,
    });
    backend.close();
  }
}
