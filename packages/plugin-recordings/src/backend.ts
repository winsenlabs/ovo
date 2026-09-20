import { mkdir, readFile, writeFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
export interface ObjectBackend {
  put(
    key: string,
    data: Uint8Array,
    contentType: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  get(key: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  close(): void;
}
function checkKey(key: string) {
  if (key.length > 900 || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(key) || key.includes('..'))
    throw new Error('Invalid recording object key');
}
function checkPrefix(prefix: string) {
  if (
    prefix.length > 800 ||
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)*\/$/.test(prefix) ||
    prefix.includes('..')
  )
    throw new Error('Invalid recording prefix');
}
export class LocalRecordingBackend implements ObjectBackend {
  constructor(
    private readonly directory: string,
    private readonly maxObjectBytes = 16 * 1024 * 1024,
  ) {}
  async put(
    key: string,
    data: Uint8Array,
    _contentType: string,
    options?: { signal?: AbortSignal },
  ) {
    checkKey(key);
    if (data.byteLength > this.maxObjectBytes) throw new Error('Oversized recording object');
    const target = join(this.directory, key),
      dir = target.slice(0, target.lastIndexOf('/'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = target + '.' + randomUUID() + '.partial';
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600, signal: options?.signal });
      if (options?.signal?.aborted)
        throw options.signal.reason ?? new Error('Recording upload interrupted');
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async get(key: string, options?: { signal?: AbortSignal }) {
    checkKey(key);
    const path = join(this.directory, key);
    if ((await stat(path)).size > this.maxObjectBytes)
      throw new Error('Oversized recording object');
    return readFile(path, { signal: options?.signal });
  }
  async delete(key: string) {
    checkKey(key);
    await unlink(join(this.directory, key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async list(prefix: string) {
    checkPrefix(prefix);
    try {
      return (await readdir(join(this.directory, prefix)))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .slice(0, 101)
        .map((name) => prefix + name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  close() {}
}
/** Real AWS SDK adapter. Live bucket IAM/retention/encryption requires staging certification. */
export class S3RecordingBackend implements ObjectBackend {
  private readonly client: S3Client;
  private readonly maxObjectBytes: number;
  constructor(
    private readonly bucket: string,
    options:
      | string
      | {
          region?: string;
          endpoint?: string;
          forcePathStyle?: boolean;
          tls?: boolean;
          maxObjectBytes?: number;
        } = {},
  ) {
    const resolved = typeof options === 'string' ? { region: options } : options;
    let endpoint: string | undefined;
    if (resolved.endpoint) {
      const parsed = new URL(resolved.endpoint);
      if (
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.pathname !== '/'
      )
        throw new Error(
          'S3-compatible endpoint must not include credentials, path, query, or fragment',
        );
      const tls = resolved.tls ?? parsed.protocol === 'https:';
      if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Invalid S3 endpoint protocol');
      if (tls && parsed.protocol !== 'https:') parsed.protocol = 'https:';
      if (!tls && parsed.protocol !== 'http:') parsed.protocol = 'http:';
      endpoint = parsed.origin;
    }
    this.maxObjectBytes = resolved.maxObjectBytes ?? 16 * 1024 * 1024;
    this.client = new S3Client({
      region: resolved.region,
      endpoint,
      forcePathStyle: resolved.forcePathStyle,
      maxAttempts: 2,
    });
  }
  async put(
    key: string,
    data: Uint8Array,
    contentType: string,
    options?: { signal?: AbortSignal },
  ) {
    checkKey(key);
    if (data.byteLength > this.maxObjectBytes) throw new Error('Oversized recording object');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
      { abortSignal: options?.signal },
    );
  }
  async get(key: string, options?: { signal?: AbortSignal }) {
    checkKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: options?.signal,
    });
    if (!result.Body || Number(result.ContentLength ?? 0) > this.maxObjectBytes)
      throw new Error('Missing or oversized recording object');
    const bytes = await result.Body.transformToByteArray();
    if (bytes.byteLength > this.maxObjectBytes)
      throw new Error('Missing or oversized recording object');
    return bytes;
  }
  async delete(key: string) {
    checkKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async list(prefix: string) {
    checkPrefix(prefix);
    const response = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 202 }),
    );
    if (response.IsTruncated) throw new Error('Recording list exceeds bounded page');
    return (response.Contents ?? []).flatMap((row) =>
      row.Key?.endsWith('.json') ? [row.Key] : [],
    );
  }
  close() {
    this.client.destroy();
  }
}
