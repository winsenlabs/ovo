import type { InboundDecision, StreamGrant } from '@winsendotai/ovo-contracts';
import { encodeExtraHeaders } from './extra-headers.ts';

const xml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;',
      })[char]!,
  );

const response = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const speak = (message: string | undefined): string =>
  message ? `<Speak>${xml(message)}</Speak>` : '';

export function streamMarkup(
  grant: StreamGrant | Extract<InboundDecision, { kind: 'connect' }>,
  contentType = 'audio/x-mulaw;rate=8000',
): string {
  const media = new URL(grant.mediaUrl);
  if (media.protocol !== 'wss:' || media.search || media.hash)
    throw new Error('Plivo Stream media URL must be WSS with no query or fragment');
  const resume = grant.resumeUrl ? new URL(grant.resumeUrl) : undefined;
  if (resume && resume.protocol !== 'https:') throw new Error('Plivo resume URL must be HTTPS');
  const attributes = [
    'bidirectional="true"',
    'keepCallAlive="true"',
    `contentType="${xml(contentType)}"`,
    `extraHeaders="${xml(encodeExtraHeaders(grant.routeParams))}"`,
    ...(grant.statusUrl ? [`statusCallbackUrl="${xml(grant.statusUrl)}"`] : []),
  ].join(' ');
  return response(
    `<Stream ${attributes}>${xml(media.toString())}</Stream>` +
      (resume ? `<Redirect method="POST">${xml(resume.toString())}</Redirect>` : ''),
  );
}

export function inboundMarkup(decision: InboundDecision, contentType?: string): string {
  switch (decision.kind) {
    case 'connect':
      return streamMarkup(decision, contentType);
    case 'wait':
      return response(
        `${decision.announce ? speak(decision.message) : ''}` +
          `<Wait length="${Math.max(1, Math.ceil(decision.pauseSeconds))}"/>` +
          `<Redirect method="POST">${xml(decision.retryUrl)}</Redirect>`,
      );
    case 'callback-offer':
      return response(
        `<GetDigits action="${xml(decision.digitsUrl)}" method="POST" numDigits="1"` +
          ` timeout="${Math.max(1, Math.ceil(decision.timeoutSeconds))}">` +
          `${speak(decision.prompt)}</GetDigits><Hangup/>`,
      );
    case 'human':
      return response(
        `${speak(decision.message)}<Dial${decision.callerId ? ` callerId="${xml(decision.callerId)}"` : ''}` +
          `${decision.timeoutSeconds ? ` timeout="${Math.ceil(decision.timeoutSeconds)}"` : ''}>` +
          `<Number>${xml(decision.e164)}</Number></Dial>`,
      );
    case 'busy':
      return response(`${speak(decision.message)}<Hangup reason="busy"/>`);
    case 'reject':
      return response('<Hangup reason="rejected"/>');
    case 'hangup':
      return response(`${speak(decision.message)}<Hangup/>`);
  }
}

export const hangupMarkup = (): string => response('<Hangup/>');
