import Ajv, { type ValidateFunction } from 'ajv';
import type { Manifest } from '@winsendotai/ovo-contracts';

/**
 * The single runtime Ajv instance (§3.2). `true` formats are annotation-only so strict mode accepts
 * zod output; zod enforces them at apply time. The runtime never imports ajv-formats.
 */
export const ANNOTATION_FORMATS = Object.freeze({
  uri: true,
  email: true,
  uuid: true,
  'date-time': true,
  date: true,
  time: true,
  duration: true,
  ipv4: true,
  ipv6: true,
  hostname: true,
} as const);

export const runtimeAjv = new Ajv({
  strict: true,
  allErrors: true,
  formats: { ...ANNOTATION_FORMATS },
});

const compiled = new WeakMap<object, ValidateFunction>();

/** Compiles once per schema object. Ajv's own cache entry is dropped so per-call schemas cannot leak. */
export function compileConfigSchema(schema: Record<string, unknown>): ValidateFunction {
  let check = compiled.get(schema);
  if (!check) {
    check = runtimeAjv.compile(schema);
    runtimeAjv.removeSchema(schema);
    compiled.set(schema, check);
  }
  return check;
}

/** The error text for invalid row config, or undefined when it is valid. */
export function configError(
  manifest: Manifest,
  config: Record<string, unknown>,
): string | undefined {
  let check: ValidateFunction;
  try {
    check = compileConfigSchema(manifest.configSchema);
  } catch (error) {
    return `Invalid config schema for ${manifest.id}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (check(config)) return undefined;
  return `Invalid config for ${manifest.id}: ${runtimeAjv.errorsText(check.errors)}`;
}

/** RFC 6901. `''` is the whole document. */
export function readPointer(document: unknown, pointer: string): unknown {
  if (pointer === '') return document;
  if (!pointer.startsWith('/')) return undefined;
  let cursor: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment))
      return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export interface CredentialReference {
  credentialRef: { credentialId: string };
}

export function isCredentialReference(value: unknown): value is CredentialReference {
  if (!value || typeof value !== 'object') return false;
  const ref = (value as { credentialRef?: unknown }).credentialRef;
  return (
    !!ref &&
    typeof ref === 'object' &&
    typeof (ref as { credentialId?: unknown }).credentialId === 'string' &&
    (ref as { credentialId: string }).credentialId.length > 0
  );
}

/** `secret.inline`: a plain string where a `{credentialRef}` must be. Checked in every mode (§3.6). */
export function inlineSecretErrors(manifest: Manifest, config: Record<string, unknown>): string[] {
  return manifest.secretFields
    .filter((pointer) => typeof readPointer(config, pointer) === 'string')
    .map(
      (pointer) =>
        `secret.inline: ${manifest.id} config ${pointer} holds a plain string; use {credentialRef:{credentialId}}`,
    );
}
