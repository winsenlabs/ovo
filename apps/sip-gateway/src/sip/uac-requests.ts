import { parseUri } from './address.ts';
import { authorization, type DigestChallenge } from './digest.ts';
import { ALLOWED_METHODS, SipHeaders, parseCSeq, type SipRequest } from './message.ts';
import { USER_AGENT, newTag } from './serialize.ts';
import { uacTimerHeaders } from './session-timer.ts';

/** Our initial INVITE to a trunk proxy (RFC 3261 §8.1.1), timer-capable, never 100rel. */
export function initialInvite(input: {
  proxy: string;
  from: string;
  to: string;
  callId: string;
  advertisedHost: string;
  via: string;
  contact: string;
  sdp: string;
}): SipRequest {
  const target = parseUri(input.proxy)!;
  const hostPort = `${target.host}${target.port ? `:${target.port}` : ''}`;
  const headers = new SipHeaders()
    .append('via', input.via)
    .append('max-forwards', '70')
    .append('from', `<sip:${input.from}@${input.advertisedHost}>;tag=${newTag()}`)
    .append('to', `<sip:${input.to}@${hostPort}>`)
    .append('call-id', input.callId)
    .append('cseq', '1 INVITE')
    .append('contact', input.contact)
    .append('allow', ALLOWED_METHODS.join(', '))
    .append('supported', 'timer')
    .append('user-agent', USER_AGENT);
  for (const [name, value] of uacTimerHeaders()) headers.append(name, value);
  headers.append('content-type', 'application/sdp');
  return {
    kind: 'request',
    method: 'INVITE',
    uri: `sip:${input.to}@${hostPort}`,
    headers,
    body: Buffer.from(input.sdp),
  };
}

/** The same INVITE with the next CSeq, a fresh branch and the digest answer (RFC 3261 §22.2). */
export function authorizedInvite(
  previous: SipRequest,
  input: {
    via: string;
    proxyAuth: boolean;
    challenge: DigestChallenge;
    username: string;
    password: string;
  },
): SipRequest {
  const headers = previous.headers.clone();
  headers.set('cseq', `${(parseCSeq(headers.get('cseq'))?.seq ?? 1) + 1} INVITE`);
  headers.delete('via');
  headers.prepend('via', input.via);
  headers.set(
    input.proxyAuth ? 'proxy-authorization' : 'authorization',
    authorization({ ...input, method: 'INVITE', uri: previous.uri }),
  );
  return { ...previous, headers };
}

/** CANCEL for our INVITE: its top Via (branch), Route, From, To, Call-ID and CSeq number (§9.1). */
export function cancelFor(invite: SipRequest): SipRequest {
  const headers = new SipHeaders().append('via', invite.headers.getAll('via')[0]!);
  for (const route of invite.headers.getAll('route')) headers.append('route', route);
  headers
    .append('max-forwards', '70')
    .append('from', invite.headers.get('from')!)
    .append('to', invite.headers.get('to')!)
    .append('call-id', invite.headers.get('call-id')!)
    .append('cseq', `${parseCSeq(invite.headers.get('cseq'))?.seq ?? 1} CANCEL`);
  return { kind: 'request', method: 'CANCEL', uri: invite.uri, headers, body: new Uint8Array() };
}
