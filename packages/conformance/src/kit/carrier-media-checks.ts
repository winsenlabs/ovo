import type { CarrierIngress, MediaCodecSession } from '@winsendotai/ovo-contracts';
import { speechBytes } from '../drivers/audio-gen.ts';
import { carrier, touchedNetwork } from './carrier-harness.ts';
import type { CarrierKitContext } from './carrier-support.ts';
import { Failures, type KitCheck } from './runner.ts';

/** Replays the inbound half of a transcript far enough for `encode` to have a live stream id. */
function primedSession(ingress: CarrierIngress, context: CarrierKitContext): MediaCodecSession {
  const transcript = context.options.transcripts?.[0];
  const session = ingress.serializer.createSession(transcript?.params ?? {});
  for (const line of transcript?.fixture.lines ?? []) {
    if (line.dir !== 'in') continue;
    let events: { type: string }[] = [];
    try {
      events = session.decode(JSON.stringify(line.frame));
    } catch {
      break;
    }
    if (events.some((event) => event.type === 'start')) break;
  }
  return session;
}

const total = (payloads: readonly Uint8Array[]) =>
  payloads.reduce((sum, payload) => sum + payload.byteLength, 0);

export const CARRIER_MEDIA_CHECKS: readonly KitCheck<CarrierKitContext>[] = [
  {
    /**
     * The transcript check used to pass on an inbound-only fixture, so `encode` and `flush` were
     * never run against the documented wire at all (#F6).
     */
    name: 'the transcripts exercise decode, encode and flush',
    async run(context) {
      const f = new Failures();
      const { ingress } = await carrier(context);
      const lines = (context.options.transcripts ?? []).flatMap((t) => t.fixture.lines);
      if (!lines.length) return ['no jsonl protocol transcripts were supplied'];
      f.expect(
        lines.some((line) => line.dir === 'in'),
        'no transcript line decodes an inbound frame',
      );
      const commands = lines.flatMap((line) =>
        line.dir === 'out' && line.command ? [(line.command as { type: string }).type] : [],
      );
      const required = ingress.capabilities.media.clear
        ? ['audio', 'mark', 'clear']
        : ['audio', 'mark'];
      for (const type of required)
        f.expect(
          commands.includes(type),
          `no transcript line encodes a '${type}' command: the encode path is untested`,
        );
      f.expect(
        lines.some((line) => line.dir === 'out' && line.flush === true),
        'no transcript line sets flush: true, so flush() is never exercised',
      );
      return f.messages;
    },
  },
  {
    name: 'close-stream carriers frame terminate() and never hang up over REST',
    async run(context) {
      const { ingress, telephony, net } = await carrier(context);
      if (ingress.capabilities.control.hangup !== 'close-stream') return [];
      const f = new Failures();
      const session = primedSession(ingress, context);
      if (
        f.expect(
          typeof session.terminate === 'function',
          'close-stream carriers must implement terminate()',
        )
      ) {
        const frames = session.terminate!();
        f.expect(Array.isArray(frames), 'terminate() must return frames');
        f.expect(
          Array.isArray(frames) && frames.length > 0,
          'terminate() returned no frames: nothing tells the carrier the call is over',
        );
        for (const [index, frame] of (Array.isArray(frames) ? frames : []).entries())
          f.expect(
            typeof frame === 'string' && frame.length > 0,
            `terminate() frame ${index} is not a non-empty string`,
          );
      }
      f.expect(
        (await telephony.hangup({ carrierCallId: 'call-1' })) === 'unsupported',
        "hangup must return 'unsupported'",
      );
      f.expect(!touchedNetwork(net), 'close-stream hangup reached the network');
      return f.messages;
    },
  },
  {
    /** The declared outbound framing is checked against the frames the codec really emits (#F7). */
    name: 'outbound audio framing matches capabilities.media.outboundChunk',
    async run(context) {
      const f = new Failures();
      const { ingress } = await carrier(context);
      const media = ingress.capabilities.media;
      const session = primedSession(ingress, context);
      const audio = speechBytes(media.formats[0]!, 1000);
      const emitted = session.encode({ type: 'audio', payload: audio });
      if (!media.outboundChunk) {
        f.expect(
          emitted.length === 1,
          `the codec split one audio command into ${emitted.length} frames without declaring media.outboundChunk`,
        );
        return f.messages;
      }
      const extract = context.options.outboundPayload;
      if (
        !f.expect(
          extract,
          'carriers that declare media.outboundChunk must supply options.outboundPayload',
        )
      )
        return f.messages;
      const { minBytes, maxBytes, multipleOf } = media.outboundChunk;
      const payloadsOf = (raw: readonly string[]) =>
        raw.flatMap((frame) => {
          const payload = extract!(frame);
          return payload ? [payload] : [];
        });
      const body = payloadsOf(emitted);
      const tail = payloadsOf(session.flush());
      body.forEach((payload, index) => {
        const bytes = payload.byteLength;
        f.expect(bytes <= maxBytes, `outbound frame ${index} is ${bytes} B, above maxBytes`);
        f.expect(bytes >= minBytes, `outbound frame ${index} is ${bytes} B, below minBytes`);
        f.expect(
          bytes % multipleOf === 0,
          `outbound frame ${index} is ${bytes} B, not a multiple of ${multipleOf}`,
        );
      });
      tail.forEach((payload, index) => {
        const bytes = payload.byteLength;
        f.expect(bytes <= maxBytes, `flushed frame ${index} is ${bytes} B, above maxBytes`);
        f.expect(
          bytes % multipleOf === 0,
          `flushed frame ${index} is ${bytes} B, not a multiple of ${multipleOf}`,
        );
      });
      f.expect(
        total([...body, ...tail]) >= audio.byteLength,
        `encode+flush emitted ${total([...body, ...tail])} B for ${audio.byteLength} B of audio`,
      );
      return f.messages;
    },
  },
];
