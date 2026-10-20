import type { HandoffTarget, InboundDecision, StreamGrant } from '@winsendotai/ovo-contracts';

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
  const status = grant.statusUrl
    ? ` statusCallback="${xml(secureUrl(grant.statusUrl, 'https:'))}" statusCallbackMethod="POST"`
    : '';
  return `<Response><Connect><Stream url="${xml(media)}"${status}>${parameters}</Stream></Connect><Redirect method="POST">${xml(resume)}</Redirect></Response>`;
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

/** https://www.twilio.com/docs/voice/twiml/sip (retrieved 2026-10-15): URI under 255 characters, headers under 1024. */
const SIP_URI_MAX = 254;
const SIP_HEADERS_MAX = 1023;
const SIP_HEADER_COUNT_MAX = 16;
const SIP_HEADER_NAME = /^X-[A-Za-z0-9-]{1,60}$/i;
const SIP_HEADER_VALUE = /^[\x20-\x7e]{0,256}$/;

/**
 * `<Dial><Sip>` for a `sip` target. Only `sip:`/`sips:` URIs with no embedded headers; context
 * rides as `X-` URI headers whose values are percent-encoded, so a value can never add a header.
 */
function sipDial(target: Extract<HandoffTarget, { kind: 'sip' }>): string {
  if (!/^sips?:[^\s<>"?&#]+$/i.test(target.uri) || target.uri.length > SIP_URI_MAX)
    throw new Error('Invalid handoff SIP URI');
  const entries = Object.entries(target.headers ?? {});
  if (entries.length > SIP_HEADER_COUNT_MAX) throw new Error('Too many SIP handoff headers');
  const query = entries
    .map(([name, value]) => {
      if (!SIP_HEADER_NAME.test(name)) throw new Error('Invalid SIP handoff header name');
      if (!SIP_HEADER_VALUE.test(value)) throw new Error('Invalid SIP handoff header value');
      return `${name}=${encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    })
    .join('&');
  if (query.length > SIP_HEADERS_MAX) throw new Error('SIP handoff headers exceed 1023 characters');
  return `<Response><Dial><Sip>${xml(query ? `${target.uri}?${query}` : target.uri)}</Sip></Dial></Response>`;
}

export function handoffMarkup(target: HandoffTarget): string {
  switch (target.kind) {
    case 'sip':
      return sipDial(target);
    case 'phone':
      if (!/^\+[1-9][0-9]{5,14}$/.test(target.e164))
        throw new Error('Invalid handoff E.164 number');
      return `<Response><Dial><Number>${xml(target.e164)}</Number></Dial></Response>`;
    case 'queue':
      if (!/^[\x20-\x7e]{1,200}$/.test(target.name)) throw new Error('Invalid Twilio queue name');
      return `<Response><Enqueue>${xml(target.name)}</Enqueue></Response>`;
    case 'end':
      return hangupMarkup(target.message);
    case 'resume':
      throw new Error('resume handoff needs callback URL');
  }
}
