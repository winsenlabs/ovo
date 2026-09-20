import { definePlugin } from '@winsendotai/ovo-runtime';
import { RecordingArchive } from './archive.ts';
import { LocalRecordingBackend, S3RecordingBackend } from './backend.ts';
export * from './archive.ts';
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
        ? new S3RecordingBackend(
            String(config.bucket),
            typeof config.region === 'string' ? config.region : undefined,
          )
        : new LocalRecordingBackend(String(config.directory));
    ctx.effect(() => () => backend.close());
    ctx.provide('ovo.recordings', new RecordingArchive(backend));
  },
);
