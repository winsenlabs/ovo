# Human queue: onboarding a third-party webhook (Wave 17)

Use this to connect a call centre or ACD that you do not run. It stays off until you turn it on
(`OVO_HUMAN_QUEUE_ENABLED`, `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`, `OVO_ROUTING_ENABLED` and
`OVO_ROUTING_TRANSFER_ENABLED`, all `true`). Concepts and the failure table:
[human-queues.md](../architecture/human-queues.md).

## What you need from the third party

1. An https endpoint on a public host that takes OVO's POST and answers within a few seconds.
2. A shared secret (OVO signs every request with it; they sign callbacks with it).
3. The numbers or SIP hosts they may transfer callers to. **OVO will only dial what you allow-list.**
4. For SIP: whether their SBC accepts REFER from your sip-gateway (`docs/architecture/sip-gateway.md`).
   If not, only phone-number destinations through a carrier that can hand a leg on (Twilio) work.

## Steps

1. **Store two credentials** in the console (`/v1/credentials`): the signing secret, and, if the
   endpoint wants an API key header, that key. Allow both for the router agent of the point.
2. **Create the queue** (`POST /v1/human-queues`, role editor). Start from the canonical body: leave
   `webhook.body` out, set `url`, `credentialId`, `destination` (prefixes, hosts, header names) and the
   `context` policy. The default policy sends no caller number and no transcript; turn on only what
   they need.
3. **Preview and test.** `POST /v1/human-queues/preview` renders your mapping offline.
   `POST /v1/human-queues/:id/test-webhook` (admin) sends one synthetic call (caller `+15550100`,
   marked `test: true`) through the real client and egress policy and shows each attempt's status, the
   time, and how the answer was read. It creates no ticket and touches no call.
4. **Map their format** if they need their own field names: `body` is a tree of literals,
   `{ "$from": "caller.number", "default": "", "maxChars": 32 }` and
   `{ "$template": "Intent {{route.intent}}" }`; `response` tells OVO which JSON pointers hold their
   status and destination. Keep it flat (`format: "form"`) if they take form posts.
5. **Bind and publish.** Add the queue to the point's `humanQueues`, point a `human` step at its key,
   publish, and fix any `routing_queue_*` finding.
6. **Place a test call** on a number bound to the new release and say you want a person. Watch the call
   inspector: `human.requested`, `human.webhook` attempts, `human.state handed_off`.

## The request

`POST` (or `PUT`), `content-type: application/json` by default. Headers OVO always sends:

| Header             | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `x-ovo-request-id` | unique per attempt                                                                |
| `x-ovo-timestamp`  | epoch seconds                                                                     |
| `x-ovo-signature`  | `v1=` + hex HMAC-SHA256 of `"<timestamp>.<request id>.<raw body>"`                |
| `idempotency-key`  | the ticket's key: **the same on every retry**; treat a repeat as the same handoff |
| `user-agent`       | `ovo-human-queue/1`                                                               |

Body (canonical `ovo.human-queue/1`; your mapping replaces it entirely):

```json
{
  "schema": "ovo.human-queue/1",
  "event": "handoff",
  "ticket": {
    "id": "…",
    "idempotencyKey": "hq:org:job:1",
    "priority": 0,
    "expiresAt": "…",
    "callbackUrl": "https://ovo.example.com/api/v1/human-queue/callbacks/<ticket>"
  },
  "queue": { "key": "support-desk", "name": "Support desk" },
  "call": { "id": "…", "direction": "inbound", "startedAt": "…" },
  "route": { "language": "hi", "intent": "billing", "path": ["intent", "billing"] },
  "handover": { "summary": "…", "reason": "…" },
  "links": { "context": "https://…/context/<ticket>?t=…", "transcript": "https://…" }
}
```

Sections the queue's `context` policy leaves off are absent. `links` are short-lived bearer links
(15 minutes) to the same filtered context, `Cache-Control: no-store`. A `cancelled` post (same ticket)
tells you OVO gave up.

## Verifying the signature: a receiver sample (Node)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOvo(secret, headers, rawBody, now = Date.now()) {
  const timestamp = headers['x-ovo-timestamp'];
  const requestId = headers['x-ovo-request-id'];
  const given = String(headers['x-ovo-signature'] ?? '');
  if (!timestamp || !requestId || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected =
    'v1=' +
    createHmac('sha256', secret).update(`${timestamp}.${requestId}.${rawBody}`).digest('hex');
  return (
    given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))
  );
}
// Hash the RAW body bytes as received, not a re-serialised object.
```

## Answering

Canonical `ovo.human-queue-response/1`:

```json
{ "status": "accepted", "ticketRef": "acd-123", "destination": { "e164": "+9140…" } }
{ "status": "accepted", "destination": { "sipUri": "sips:agent7@acd.example.com", "headers": { "X-Acd-Ticket": "123" } } }
{ "status": "queued", "ticketRef": "acd-123" }
{ "status": "rejected", "reason": "closed" }
```

- `accepted` needs **exactly one** destination. `queued` means "I will call back with one".
- Non-2xx, a timeout, 408/429 and 5xx are retried (up to 3 attempts in 15 s, backing off from 500 ms,
  the same `idempotency-key`); any other 4xx is final. A body that is not JSON, or has no usable
  status, is `invalid` and is not retried.

## Calling back

`POST <callbackUrl>` with a JSON body, **signed like the request** over
`"<timestamp>.<event id>.<raw body>"` using `x-ovo-timestamp` and `x-ovo-event-id`
(unique per event: a repeat is acknowledged and ignored):

```json
{ "eventId": "evt-77", "event": "destination", "sipUri": "sips:agent7@acd.example.com" }
{ "eventId": "evt-78", "event": "accepted" }
{ "eventId": "evt-79", "event": "released" }
{ "eventId": "evt-80", "event": "outcome", "outcome": "answered" }
```

`destination` is honoured while the caller still waits (before the queue's hold ends). The other three
are recorded on the call for `callbackWindowHours` (24) after the leg left, and show in the call
inspector. Answers: `202 {result: "applied"|"duplicate"}`, `401` bad signature or stale timestamp,
`404` unknown ticket, `410` scrubbed or past the window, `413` over 16 KiB, `422` bad body, `429`.

## When it does not work

| You see                                                       | Cause                                                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `routing_queue_webhook_disabled` at publish                   | `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED` is off                                                             |
| `routing_queue_credential_missing`                            | the signing credential is not allowed for the router agent                                           |
| `routing_queue_destination_policy_empty`                      | no allowed prefix: add at least one                                                                  |
| `human.webhook … failed` with `http_503`, `timeout`           | their endpoint; check the attempts in `test-webhook`                                                 |
| `destination_refused:e164_prefix` / `sip_host` / `sip_scheme` | the answer is outside your allow-list                                                                |
| callers fall to the hold chain                                | webhook failed, was rejected, or `queued` never called back in time                                  |
| `queue_unavailable` right away                                | five webhook failures in 60 s opened the breaker for 30 s                                            |
| the caller stays after `accepted`                             | the carrier refused the handoff (`carrier_refused:<reason>`); see the carrier's handoff capabilities |
