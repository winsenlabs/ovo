import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { RoutingAudioName, TRANSFER_LIMITS } from '@winsendotai/ovo-contracts';
import { z } from 'zod';
import { convertRoutingAudio, RoutingAudioRefusal, routingAudioWav } from '../routing-audio.ts';
import {
  routed,
  routingPage,
  sendError,
  type RoutingAudit,
  type RoutingRouteDependencies,
} from './routing-support.ts';

const AudioParams = z.object({ audioId: z.uuid() });
const UploadQuery = z.object({ name: RoutingAudioName });
/** What a browser or a tool labels a WAV file; the bytes are checked whatever the label says. */
export const WAV_CONTENT_TYPES = ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'];

/**
 * Hold clips (Wave 16, design 6): operator-uploaded WAV converted once to 8 kHz μ-law, listed and
 * previewed, soft-deleted only while no point draft names them. Releases pin a clip by sha256, so
 * a deleted clip keeps playing for the releases that already pinned it.
 */
export function registerRoutingAudioRoutes(
  input: RoutingRouteDependencies & { audit: RoutingAudit },
): void {
  const { app, audit } = input;
  const notFound = (reply: FastifyReply) =>
    sendError(reply, 404, 'routing_audio_not_found', 'Hold clip not found');

  // Raw WAV bytes, never parsed as anything else. The route's own body limit applies, and Fastify
  // refuses a larger declared or streamed body before buffering it.
  app.addContentTypeParser(WAV_CONTENT_TYPES, { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.get(
    '/v1/routing/audio',
    routed(input, 'viewer', ({ request, routing }) =>
      routingPage(request, (limit, cursor) => routing.audio.list(limit, cursor)),
    ),
  );

  app.post(
    '/v1/routing/audio',
    { bodyLimit: TRANSFER_LIMITS.uploadBytes, errorHandler: uploadErrors },
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { name } = UploadQuery.parse(request.query);
      if (!Buffer.isBuffer(request.body))
        return sendError(
          reply,
          415,
          'routing_audio_unsupported',
          `Send the clip as raw ${WAV_CONTENT_TYPES[0]}`,
        );
      let converted;
      try {
        converted = convertRoutingAudio(request.body);
      } catch (error) {
        if (!(error instanceof RoutingAudioRefusal)) throw error;
        return sendError(reply, error.status, error.code, error.message);
      }
      const created = await routing.audio.create({
        name,
        ...converted,
        createdBy: principal.identityId,
      });
      if (created === 'name_taken')
        return sendError(reply, 409, 'routing_audio_name_taken', 'Another clip has this name');
      await audit(principal, 'routing.audio.create', 'routing_audio', created.id, {
        name: created.name,
        durationMs: created.durationMs,
        sha256: created.sha256,
        source: created.source,
      });
      return reply.code(201).send(created);
    }),
  );

  app.get(
    '/v1/routing/audio/:audioId',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { audioId } = AudioParams.parse(request.params);
      const found = await routing.audio.get(audioId);
      if (!found) return notFound(reply);
      return { ...found, usedBy: await routing.audio.usedBy(audioId) };
    }),
  );

  app.get(
    '/v1/routing/audio/:audioId/content',
    routed(input, 'viewer', async ({ request, reply, routing }) => {
      const { audioId } = AudioParams.parse(request.params);
      const found = await routing.audio.get(audioId);
      const audio = found && (await routing.audio.content(audioId, found.sha256));
      if (!found || !audio) return notFound(reply);
      const wav = routingAudioWav(audio);
      return reply
        .type('audio/wav')
        .header('content-disposition', `attachment; filename="${audioId}.wav"`)
        .header('x-content-type-options', 'nosniff')
        .header('content-length', String(wav.byteLength))
        .send(Buffer.from(wav));
    }),
  );

  app.delete(
    '/v1/routing/audio/:audioId',
    routed(input, 'editor', async ({ request, reply, principal, routing }) => {
      const { audioId } = AudioParams.parse(request.params);
      const removed = await routing.audio.remove(audioId);
      if (removed === 'missing') return notFound(reply);
      if (removed !== 'removed')
        return sendError(reply, 409, 'routing_audio_in_use', 'Point drafts still name this clip', {
          usedBy: removed.inUseBy,
        });
      await audit(principal, 'routing.audio.delete', 'routing_audio', audioId);
      return reply.code(204).send();
    }),
  );
}

/**
 * Body refusals Fastify raises before the handler runs, in this API's codes: too large (413) and
 * a content type no parser accepts (415). Everything else goes to the API's own error handler.
 */
function uploadErrors(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.statusCode === 413)
    return sendError(
      reply,
      413,
      'routing_audio_too_large',
      `A hold clip upload is at most ${TRANSFER_LIMITS.uploadBytes} bytes`,
    );
  if (error.statusCode === 415)
    return sendError(
      reply,
      415,
      'routing_audio_unsupported',
      `Send the clip as raw ${WAV_CONTENT_TYPES[0]}`,
    );
  throw error;
}
