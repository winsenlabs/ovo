import { definePlugin } from '@winsendotai/ovo-runtime';
import { RecordingArchive } from './archive.ts';
import { LocalRecordingBackend, S3RecordingBackend } from './backend.ts';
export * from './archive.ts';
export * from './backend.ts';
export * from './background-worker.ts';
export * from './capture.ts';
export * from './config.ts';
export * from './exports.ts';
export * from './live-service.ts';
export * from './memory-repository.ts';
export * from './repository.ts';
export * from './replay.ts';
export * from './retention.ts';
export * from './types.ts';
export * from './wav.ts';
export const recordingsPlugin = definePlugin(
  {
    id: 'ovo.recordings',
    version: '1.0.0',
    contractVersion: 1,
    scope: 'process',
    provides: ['ovo.recordings'],
    requires: [],
    configSchema: {
      type: 'object',
      properties: {
        backend: { enum: ['local', 's3'] },
        directory: { type: 'string', minLength: 1 },
        bucket: { type: 'string', minLength: 3 },
        region: { type: 'string' },
        endpoint: { type: 'string', minLength: 1 },
        forcePathStyle: { type: 'boolean' },
        tls: { type: 'boolean' },
      },
      required: ['backend'],
      additionalProperties: false,
    },
    secretFields: [],
    ui: { label: 'Recordings' },
  },
  (ctx, config) => {
    if (config.backend === 'local' && process.env.NODE_ENV === 'production')
      throw new Error('Local recording storage is development-only');
    if (config.backend === 'local' && typeof config.directory !== 'string')
      throw new Error('Local recording directory required');
    if (config.backend === 's3' && typeof config.bucket !== 'string')
      throw new Error('S3 recording bucket required');
    const backend =
      config.backend === 's3'
        ? new S3RecordingBackend(String(config.bucket), {
            region: typeof config.region === 'string' ? config.region : undefined,
            endpoint: typeof config.endpoint === 'string' ? config.endpoint : undefined,
            forcePathStyle:
              typeof config.forcePathStyle === 'boolean' ? config.forcePathStyle : undefined,
            tls: typeof config.tls === 'boolean' ? config.tls : undefined,
          })
        : new LocalRecordingBackend(String(config.directory));
    ctx.effect(() => () => backend.close());
    ctx.provide('ovo.recordings', new RecordingArchive(backend));
  },
);

export const plugins = [recordingsPlugin];
