import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  Cap,
  PCM16_8K,
  type NetPort,
  type SecretResolver,
  type TextToSpeech,
  type UsageMeter,
} from '@winsendotai/ovo-contracts';
import { createNodeNet } from '@winsendotai/ovo-plugin-kit';
import { encodeRecordingWav } from '@winsendotai/ovo-plugin-recordings';
import { adaptTextToSpeech } from '@winsendotai/ovo-session-host';
import type { ProviderBinding } from '@winsendotai/ovo-plugin-storage';
import {
  compose,
  definePlugin,
  manifestKeys,
  PluginRegistry,
  type PluginDefinition,
} from '@winsendotai/ovo-runtime';

export const DEFAULT_PREVIEW_TEXT =
  'Hello, this is a preview of the voice your callers will hear on this line.';
/** Longest a preview may synthesise before it is cut off, and the most audio it may return. */
export const PREVIEW_TIMEOUT_MS = 15_000;
const MAX_PREVIEW_BYTES = 16_000 * 30;

const PreviewBody = z
  .object({
    text: z.string().trim().min(1).max(300).optional(),
    voice: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .default({});

export interface PreviewDependencies {
  app: FastifyInstance;
  store: {
    getProviderBinding(workspaceId: string, id: string): Promise<ProviderBinding | undefined>;
    audit(entry: Record<string, unknown>): Promise<unknown>;
  };
  /** The workspace's credentials; a preview is an operator action, not an agent's. */
  secrets: SecretResolver;
  catalog: readonly PluginDefinition[];
  requireRole: (
    request: FastifyRequest,
    role: 'admin',
  ) => { workspaceId: string; identityId?: string };
  error: (reply: FastifyReply, status: number, code: string, message: string) => unknown;
  /** Defaults to the production address-guarded network. */
  net?: NetPort;
}

/**
 * `POST /v1/provider-bindings/:id/preview` (TTS-3): renders a short line with a TTS binding and
 * returns it as 8 kHz 16-bit PCM WAV, the telephone band a caller hears, in a format every browser
 * plays. Admin only: every preview is a billed provider request, and it is audited with the
 * characters it spent. It runs the binding's installed plugin in a throwaway graph, exactly as a
 * call would, so a preview that works proves the binding and its credential.
 */
export function registerProviderBindingPreview(dependencies: PreviewDependencies): void {
  const { app, store, catalog, requireRole, error } = dependencies;
  let net = dependencies.net;
  app.post(
    '/v1/provider-bindings/:bindingId/preview',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const principal = requireRole(request, 'admin');
      const { bindingId } = z
        .object({ bindingId: z.string().min(1).max(200) })
        .parse(request.params);
      const body = PreviewBody.parse(request.body ?? {});
      const binding = await store.getProviderBinding(principal.workspaceId, bindingId);
      if (!binding) return error(reply, 404, 'not_found', 'Provider binding not found');
      const definition = ttsDefinition(binding, catalog);
      if (!definition)
        return error(reply, 409, 'binding_not_tts', 'Only a TTS binding can preview a voice');
      net ??= createNodeNet();
      const text = body.text ?? DEFAULT_PREVIEW_TEXT;
      let audio: Uint8Array;
      let usage: UsageMeter[];
      try {
        ({ audio, usage } = await synthesizePreview({
          definition,
          binding,
          secrets: dependencies.secrets,
          net,
          text,
          ...(body.voice ? { voice: body.voice } : {}),
        }));
      } catch (failure) {
        request.log.warn({ err: failure, bindingId }, 'provider binding preview failed');
        return error(
          reply,
          502,
          'preview_failed',
          `The provider could not render the preview: ${(failure as Error).message}`.slice(0, 500),
        );
      }
      await store.audit({
        workspaceId: principal.workspaceId,
        actorId: principal.identityId,
        action: 'provider-binding.preview',
        resourceType: 'provider-binding',
        resourceId: bindingId,
        payload: { pluginId: definition.manifest.id, characters: [...text].length },
      });
      return reply
        .header('content-type', 'audio/wav')
        .header('cache-control', 'no-store')
        .header('x-ovo-preview-characters', String([...text].length))
        .header('x-ovo-preview-meters', String(usage.length))
        .send(Buffer.from(encodeRecordingWav(PCM16_8K, audio)));
    },
  );
}

/** The installed TTS plugin a binding names, or the provider's only one for a legacy binding. */
function ttsDefinition(
  binding: ProviderBinding,
  catalog: readonly PluginDefinition[],
): PluginDefinition | undefined {
  const registry = new PluginRegistry(catalog);
  let definition: PluginDefinition | undefined;
  try {
    definition = binding.pluginId
      ? registry.get(binding.pluginId)
      : registry.resolve('tts', binding.provider);
  } catch {
    return undefined;
  }
  return definition && manifestKeys(definition.manifest).manifest.kind === 'tts'
    ? definition
    : undefined;
}

async function synthesizePreview(input: {
  definition: PluginDefinition;
  binding: ProviderBinding;
  secrets: SecretResolver;
  net: NetPort;
  text: string;
  voice?: string;
}): Promise<{ audio: Uint8Array; usage: UsageMeter[] }> {
  const usage: UsageMeter[] = [];
  const host = definePlugin(
    {
      id: '@winsendotai/ovo-api/preview-host',
      version: '0.1.0',
      contractVersion: 2,
      scope: 'session',
      kind: 'host',
      provides: [Cap.secrets, Cap.usage],
      requires: [],
      configSchema: { type: 'object', additionalProperties: false },
      secretFields: [],
    },
    (ctx) => {
      ctx.provide(Cap.secrets, input.secrets);
      ctx.provide(Cap.usage, (meter: UsageMeter) => void usage.push(meter));
    },
  );
  const composition = await compose(
    [
      { id: host.manifest.id },
      {
        id: input.definition.manifest.id,
        config: {
          binding: structuredClone(input.binding.config),
          credentialRef: { credentialId: input.binding.credentialId },
          workspaceId: input.binding.workspaceId,
          bindingId: input.binding.id,
          updatedAt: input.binding.updatedAt,
        },
      },
    ],
    [host, input.definition],
    { scope: 'session', workspaceId: input.binding.workspaceId, net: input.net },
  );
  const signal = AbortSignal.timeout(PREVIEW_TIMEOUT_MS);
  try {
    const native = composition.ctx.get(Cap.tts) as TextToSpeech | undefined;
    if (!native) throw new Error(`${input.definition.manifest.id} provided no TTS`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of adaptTextToSpeech(native).synthesize({
      sessionId: `preview:${input.binding.id}`,
      text: input.text,
      format: PCM16_8K,
      language: 'en',
      ...(input.voice ? { voice: input.voice } : {}),
      kind: 'response',
      signal,
      onUsage: (meter) => void usage.push(meter),
    })) {
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes >= MAX_PREVIEW_BYTES) break;
    }
    const audio = new Uint8Array(Math.min(bytes, MAX_PREVIEW_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, audio.byteLength - offset);
      audio.set(part, offset);
      offset += part.byteLength;
    }
    if (!audio.byteLength) throw new Error('the provider returned no audio');
    return { audio, usage };
  } finally {
    await composition.dispose();
  }
}
