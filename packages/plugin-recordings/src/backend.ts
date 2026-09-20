import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
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
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  close(): void;
}
function checkKey(key: string) {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-f0-9-]+\.(wav|json)$/.test(key))
    throw new Error('Invalid recording object key');
}
export class LocalRecordingBackend implements ObjectBackend {
  constructor(private readonly directory: string) {}
  async put(key: string, data: Uint8Array, _contentType: string) {
    checkKey(key);
    const target = join(this.directory, key),
      dir = target.slice(0, target.lastIndexOf('/'));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temporary = target + '.' + randomUUID() + '.partial';
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  async get(key: string) {
    checkKey(key);
    return readFile(join(this.directory, key));
  }
  async delete(key: string) {
    checkKey(key);
    await unlink(join(this.directory, key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  async list(prefix: string) {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(prefix))
      throw new Error('Invalid recording prefix');
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
  constructor(
    private readonly bucket: string,
    region?: string,
  ) {
    this.client = new S3Client({ region, maxAttempts: 2 });
  }
  async put(key: string, data: Uint8Array, contentType: string) {
    checkKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }
  async get(key: string) {
    checkKey(key);
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || Number(result.ContentLength ?? 0) > 5 * 1024 * 1024)
      throw new Error('Missing or oversized recording object');
    return result.Body.transformToByteArray();
  }
  async delete(key: string) {
    checkKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
  async list(prefix: string) {
    if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/$/.test(prefix))
      throw new Error('Invalid recording prefix');
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
