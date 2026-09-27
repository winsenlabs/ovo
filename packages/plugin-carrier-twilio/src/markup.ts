import type { InboundDecision, StreamGrant } from '@winsendotai/ovo-contracts';

export function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
    throw new Error('Invalid XML control character');
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function secureUrl(value: string, protocol: 'wss:' | 'https:'): string {
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.hash)
    throw new Error(`Twilio URL must be ${protocol}// without credentials or fragment`);
  return value;
}

export function connectMarkup(grant: Omit<StreamGrant, 'kind'>): string {
  if (!grant.routeParams.sid || !grant.routeParams.rt)
    throw new Error('Twilio Stream requires sid and rt route parameters');
  const media = secureUrl(grant.mediaUrl, 'wss:');
  if (new URL(media).search) throw new Error('Twilio Stream URL must not carry a query');
  if (!grant.resumeUrl) throw new Error('Twilio continuation needs resumeUrl');
  const resume = secureUrl(grant.resumeUrl, 'https:');
  const parameters = Object.entries(grant.routeParams)
    .map(([name, value]) => {
      if (name.length + value.length >= 500)
        throw new Error('Twilio Stream parameter exceeds 500 characters');
      return `<Parameter name="${xml(name)}" value="${xml(value)}"/>`;
    })
    .join('');
  return `<Response><Connect><Stream url="${xml(media)}">${parameters}</Stream></Connect><Redirect method="POST">${xml(resume)}</Redirect></Response>`;
}

export function hangupMarkup(message?: string): string {
  return `<Response>${message ? `<Say>${xml(message)}</Say>` : ''}<Hangup/></Response>`;
}

export function inboundMarkup(decision: InboundDecision): string {
  switch (decision.kind) {
    case 'connect':
      return connectMarkup(decision);
    case 'wait': {
      const say =
        decision.announce && decision.message ? `<Say>${xml(decision.message)}</Say>` : '';
      const pause = Math.max(1, Math.ceil(decision.pauseSeconds));
      return `<Response>${say}<Pause length="${pause}"/><Redirect method="POST">${xml(secureUrl(decision.retryUrl, 'https:'))}</Redirect></Response>`;
    }
    case 'callback-offer':
      return `<Response><Gather input="dtmf" numDigits="1" timeout="${Math.max(1, Math.ceil(decision.timeoutSeconds))}" action="${xml(secureUrl(decision.digitsUrl, 'https:'))}" method="POST"><Say>${xml(decision.prompt)}</Say></Gather><Hangup/></Response>`;
    case 'human': {
      const say = decision.message ? `<Say>${xml(decision.message)}</Say>` : '';
      const attrs = [
        decision.callerId ? `callerId="${xml(decision.callerId)}"` : '',
        decision.timeoutSeconds ? `timeout="${Math.ceil(decision.timeoutSeconds)}"` : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `<Response>${say}<Dial${attrs ? ` ${attrs}` : ''}><Number>${xml(decision.e164)}</Number></Dial></Response>`;
    }
    case 'busy':
      return `<Response>${decision.message ? `<Say>${xml(decision.message)}</Say>` : ''}<Reject reason="busy"/></Response>`;
    case 'reject':
      return '<Response><Reject/></Response>';
    case 'hangup':
      return hangupMarkup(decision.message);
  }
}
