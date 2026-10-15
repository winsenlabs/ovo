# Human queues: a third-party queue or the OVO operator desk (Wave 17, R3)

**State:** built behind switches that are all off by default. With `OVO_HUMAN_QUEUE_ENABLED=false` a
routed call runs byte for byte as Wave 16: `human` routing steps are skipped, no ticket is ever
created, and `/v1/human-queues`, `/v1/desk` and `/v1/human-queue` answer `404 human_queue_disabled`.
Operations migration 013 and outcomes migration v4 are additive and apply regardless; **take a
backup before deploying them**, a code rollback does not undo them.

A person is **a segment**. R3 adds no second call path: a human queue is one more kind of target for
the R2 transfer controller, so the router's `human` fallback step and branch target, an agent's
`transfer_to_agent` to a catalogue target whose destination is a queue, and the hold's `human`
timeout step all use it. One carrier leg, one media link, one recording, one cost reservation and one
call record run throughout.

## The two kinds

|                           | `external` (a third-party ACD)                                                   | `managed` (the OVO operator desk)                                             |
| ------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Who answers               | A call centre you do not run                                                     | A person in the OVO console                                                   |
| How OVO reaches them      | One signed webhook, then a carrier transfer to the number or SIP URI they answer | A room: the worker joins as `caller`, the operator joins from the browser     |
| Does OVO stay on the call | No: the leg leaves OVO (`transferred`)                                           | Yes: OVO bridges both sides, records, meters                                  |
| Needs                     | `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED`, a carrier that can hand a leg on              | `OVO_LIVEKIT_ENABLED` and the room server (`docs/runbooks/livekit-deploy.md`) |
| Staffing                  | Theirs                                                                           | Operator profiles (`/v1/human-queues/operators`) and presence                 |

Both run on one durable **ticket** (`ovo_hq_tickets`) that the worker (which holds the call), the API
(which serves operators and receives callbacks) and the dispatcher's sweeper (which assigns and
expires) share. They never talk to each other directly; they meet in PostgreSQL.

## Concepts

- **Queue.** A workspace entity (`ovo_hq_queues`, `/v1/human-queues`), defined once and reused by
  several routing points. A point's draft binds queue _keys_ to queue ids (`humanQueues`); publish
  copies each bound queue's definition into the release snapshot (schemaVersion 3), so a published
  release never changes behaviour under a bound number. Staffing is live, not pinned.
- **Ticket.** One human handoff of one call: `waiting`, `offered`, `accepted`, `released`, `expired`.
  Idempotent by `hq:<org>:<callId>:<n>`; one active ticket per call.
- **Operator.** A console user plus a profile (`enabled`, `teamIds`, `languages`, `capacity`) and
  presence (`AVAILABLE`, `AWAY`, `OFFLINE`, kept alive by a 10 s heartbeat; older than 30 s reads
  `OFFLINE`). There is no new role: the desk needs `viewer` and an enabled profile.
- **Hold.** The R2 hold plays while the ticket waits. Its precedence for a queue is the queue's own,
  then the catalogue target's, then the point's, then the built-in `DEFAULT_QUEUE_HOLD_POLICY`
  (2 s of silence and the hold line, 180 s, then `return`, `default`, `end`).
- **Context.** What the queue may know about the call (`context` policy): caller id, called number,
  language, intent, the transferring agent's summary, transcript turns, a transcript link,
  variables. External queues default to the minimum (no caller id, no transcript).

## State machine

```
            create (idempotent by key, one active per call; frees the call's earlier ticket)
               ▼
           waiting ──AUTO_ASSIGN pick──▶ offered ──accept (CAS on version)──▶ accepted
               │  ▲                         │  │                                  │
               │  └── decline / offer lapses┘  │                                  │
               │  ▲                            │                                  │
               │  └────────── reoffer (operator never joined) ◀───────────────────┤
               │                                                                    │
               └──accept (OPEN_PICKUP, CAS)───────────────────────────────────────▶│
 any active ──release (worker, operator, admin, callback)──▶ released     (terminal)
 waiting/offered past expires_at ──sweeper──▶ expired                       (terminal)
 no worker heartbeat for 20 s ──sweeper──▶ released (worker_lost)
```

Every transition bumps `version` and `change_id` and appends an audit event (`ovo_hq_ticket_events`:
state, code, operator id; never caller text). Rules, each with a PostgreSQL test:

- **Accept is a compare-and-set** on `version`. Of several operators accepting one ticket exactly one
  wins; the rest get `conflict`. A repeat with the same idempotency key returns the same ticket.
- **Eligibility.** The operator is enabled and not `OFFLINE`; shares a team with the queue (a queue
  with no teams takes every enabled operator); speaks the call's language when the queue says
  `require`; has not declined the ticket; and, for an offered ticket, is the one it was offered to.
- **Capacity.** The count of an operator's `accepted` tickets is checked under a per-operator
  advisory lock, so two accepts for different tickets cannot both squeeze past the limit
  (`at_capacity`). Offers count against room when picking.
- **AUTO_ASSIGN pick.** Language match first (`prefer`), then the lightest load (accepted plus
  offered), then the longest idle, then the user id; highest priority and oldest ticket first. An
  offer expires after `offerSeconds` (20) and rotates to the next operator; nobody is offered the same
  ticket twice (`declined_by`). Offers happen when the ticket is created and once a second in the
  sweeper.
- **No-show.** An operator who accepts but is not in the room within `joinSeconds` (25) is dropped:
  the worker calls `reoffer`, the operator joins `declined_by`, the caller keeps holding.
- **Worker loss.** The worker beats every 5 s while it holds an active ticket; the sweeper releases a
  ticket without a beat for 20 s as `worker_lost`.
- **Scrub.** A ticket's context, caller mask, command and context token are nulled
  `OVO_HUMAN_QUEUE_CONTEXT_RETENTION_HOURS` (24; 0 scrubs at the end) after it ends. The ticket and
  its events stay (ids and codes only).
- **Commands.** The assigned operator's `end_call` or `return_to_agent` is stored with a sequence
  number; the worker executes it and acks. The room's data channel carries captions only, never
  commands: one authority path, authorised by the session, role, profile and ownership.

The change feed behind the desk stream reads `change_id` in order. A sequence value is taken when a
statement runs and becomes visible when its transaction commits, so a poller should re-read a short
window behind its cursor and de-duplicate by `(id, version)`.

## Flow 1: a third-party queue

```
router ─ human step ─▶ begin: queue open? webhook enabled? breaker closed? ─▶ queued
caller hears the announcement ─▶ hold plays ─▶ the worker posts the webhook (signed, idempotent)
   ├─ answer accepted + destination ─▶ policy check ─▶ carrier handoff ─▶ session ends `transferred`
   ├─ answer queued ───────────────▶ hold continues ─▶ signed callback `destination` ─▶ as above
   └─ 4xx / 5xx after retries / rejected / destination outside policy ─▶ the hold's timeout chain
later: accepted | released | outcome callbacks are recorded on the finished call
```

- **Request.** `POST` of a field-mapping template over a fixed context namespace (JSON or form) or the
  canonical `ovo.human-queue/1` body. Headers: `x-ovo-request-id`, `x-ovo-timestamp`,
  `x-ovo-signature: v1=<hex HMAC-SHA256(secret, "<ts>.<requestId>.<body>")>`, `idempotency-key` (the
  same on every retry) and `user-agent: ovo-human-queue/1`. Sent through the pinned HTTP client:
  https only, public addresses only, DNS pinned per attempt, no redirects, a 16 KiB response cap.
- **Retries.** Up to `attempts` (3) within `deadlineMs` (15 s) and the remaining hold, doubling from
  `baseMs` (500 ms) with 20 % jitter; network errors, timeouts, 5xx, 408 and 429 retry (a
  `Retry-After` up to 10 s is honoured), any other 4xx is final. Five failures in 60 s open the
  queue's circuit breaker for 30 s, which turns the precheck into `queue_unavailable`.
- **Answer.** `ovo.human-queue-response/1` or your own shape read through JSON pointers
  (`response`). `accepted` needs exactly one destination; `queued` waits for the callback;
  `rejected` ends the attempt.
- **Destination policy (toll-fraud guard, mandatory).** An E.164 number must start with an allowed
  prefix. A SIP URI must be `sips:` (unless relaxed) on an allowed host (exact or `.suffix`), carry no
  parameters, headers or password. Only listed `X-` headers pass; a listed header with an unprintable
  or oversize value refuses the answer. One handoff per ticket.
- **Handoff.** `TelephonyControl.handoff` with `{kind:'phone'}` or `{kind:'sip', uri, headers}`: the
  Twilio carrier answers with `<Dial><Number|Sip>`; the SIP and TCN carriers send a REFER through the
  sip-gateway where the trunk enables it (`refer.enabled`, default off). Context travels in
  `X-OVO-Call-Id`, `X-OVO-Ticket`, `X-OVO-Language`, `X-OVO-Intent`, `X-OVO-Context-Url` and the
  answer's allowed headers. The caller stays on the line when the carrier refuses.
- **Callbacks.** `POST /v1/human-queue/callbacks/:ticketId`, signed like the request over
  `"<ts>.<eventId>.<body>"` with the queue's credential resolved for the router agent on the ticket
  (300 s clock skew, event-id uniqueness as the replay guard, rate limited). `destination` is honoured
  while the ticket waits; `accepted | released | outcome` are recorded for `callbackWindowHours` (24)
  and appended to the call as `human.state` events with `by: callback`, so the call inspector shows
  them after the call ended.
- **Cancel.** When OVO gives up (hold timeout, caller hung up) after reaching the third party and
  `cancel` is on, it sends one best-effort `event: "cancelled"` post.

## Flow 2: the OVO operator desk

```
router ─ human step ─▶ begin: queue open? room healthy? an operator online with room? ─▶ queued
announcement ─▶ hold ─▶ ticket `waiting` ─▶ the desk shows it (SSE) ─▶ operator clicks Accept
API: ensureRoom, CAS accept, mint a 120 s room-scoped token ─▶ browser joins the room (mic)
worker sees `accepted`: joins the room as `caller`, waits for the operator (≤ joinSeconds)
operator present ─▶ hold stops ─▶ caller audio ⇄ operator audio, captions to the desk
end: the operator ends the call / sends the caller back to an AI agent / leaves / the caller hangs up
```

- **Bridge.** The worker already holds both directions of the caller's audio through its segment
  lease and the recording tap sits below it, so every byte the operator and the caller exchange is
  recorded on the one track. Caller audio goes into the room; operator audio is decoded into the
  lease. A backed-up lease drops the oldest frames and counts them; `clear()` is never called.
- **AI presence** (`ai.mode`). `transcribe` (default) keeps the router release's STT open on both
  sides for captions and the call transcript, under the call's transcript policy; `out` opens none.
- **Return to an AI agent.** `return_to_agent` with a key in the queue's `returnTargets`: the point's
  announcement is spoken in the house voice, then the normal begin, commit, hold, connect path runs.
- **Operator leaves.** A 5 s grace for a reconnect with the same token, then `onOperatorLeave`
  (`end_call`, or `return_to_agent` to `returnDefault`).
- **Tokens.** Minted only by the API at accept (and on reconnect): identity `op:<userId>`, role
  `operator`, audio publish and subscribe only, `canPublishData: false`, no admin, list or create,
  120 s, one room named `ovo-hq-<ticket uuid>` (three participants at most).
- **Cost.** A human segment's `segment.ended` carries `ovo.human.operator_seconds` (connected to end)
  and `ovo.human.room_seconds` plus the transcriber's STT; the ledger prices them as host meters
  (provider `ovo`, unit `seconds`) on the segment. An unpriced human meter is reported as missing and
  never refuses or ends a call.

## Failure table

Before the router finishes (`begin`; the requester keeps control and the node's own chain continues
with `route.fallback human failed <reason>`):

| Failure                                                             | Behaviour                                | Code                      |
| ------------------------------------------------------------------- | ---------------------------------------- | ------------------------- |
| Master flag off, transfers off, or the key is not bound             | the `human` step is skipped as in R2     | `human_queue_unavailable` |
| Queue closed by its hours                                           | refused before any announcement          | `queue_closed`            |
| Webhook flag off or breaker open; room provider absent or unhealthy | refused                                  | `queue_unavailable`       |
| Nobody online with room (`requireOnline`)                           | refused; the router offers its next step | `no_operators`            |
| `maxWaiting` reached                                                | refused (checked again at creation)      | `queue_full`              |

After commit (the caller holds; the hold's `onTimeout` chain runs):

| Failure                                                                              | Behaviour                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Ticket creation fails                                                                | storage down is fail-closed for humans; chain                                          |
| Webhook: all attempts fail, 4xx, invalid answer, oversize, redirect, private address | ticket `released webhook_failed`; chain                                                |
| Webhook answers `rejected`                                                           | chain at once                                                                          |
| Destination outside the policy                                                       | never dialled; chain                                                                   |
| `queued` but no destination by `hold.maxSeconds`                                     | cancel post; chain                                                                     |
| Carrier refuses the handoff                                                          | caller still on the line; chain                                                        |
| Carrier outcome unknown (no NOTIFY, no receipt)                                      | treated as handed on; no retry                                                         |
| Managed: nobody accepts by `hold.maxSeconds`                                         | ticket `expired`; chain                                                                |
| Operator accepts but never joins                                                     | seat closed, ticket re-offered (`operator_no_show`), the hold continues                |
| Operator declines or the offer lapses                                                | AUTO_ASSIGN: next operator; OPEN_PICKUP: hidden for them                               |
| `ensureRoom` fails at accept                                                         | the API refuses (`room_unavailable`); the ticket is untouched                          |
| Room server dies mid-call                                                            | audio stops; 5 s reconnect; then `onOperatorLeave`                                     |
| Operator closes the tab                                                              | seat sees `left`; 5 s grace; `onOperatorLeave`                                         |
| Worker crashes with an accepted ticket                                               | the call is lost as today; `worker_lost` after 20 s; the room is deleted by the reaper |
| Caller hangs up while waiting                                                        | ticket released `call_ended`; no room is ever created; cancel post                     |
| Transcriber fails                                                                    | captions off for the rest of the call; the call is unaffected                          |
| Overflow chain names a queue already tried                                           | publish error; at run time the step fails `queue_loop`                                 |
| Every step fails                                                                     | the default agent, then the built-in end line (R2)                                     |

Platform: PostgreSQL down fails ticket creation closed (the chain runs; no call is left silent). With
no dispatcher the sweeper does not run: AUTO_ASSIGN offers happen once at creation, and the worker
still enforces its own hold deadline. A room server restart drops live human calls; new accepts work
once its health recovers.

## Limits

Ten queues per point; `maxWaiting` 1-500 per queue (default 100); hold `maxSeconds` 5-900; at most 20
teams, 10 return targets, 20 variables and 20 transcript turns in a queue's context policy; a webhook
body of at most 64 KiB and a response of at most 16 KiB; 5 attempts within 60 s; a mapping at most 6
levels and 200 nodes deep; a ticket event payload under 4 KiB; a data-channel message at most 4 KiB.
The human talks inside the call's `maxCallSeconds` (publish warns below 900 s).

## Security and data

- **Egress.** Webhooks use the pinned client (https, public addresses, no redirects, byte caps);
  `OVO_HUMAN_QUEUE_WEBHOOK_ENABLED=false` removes the egress.
- **Signing.** Outbound and inbound use the `v1=` HMAC with a timestamp; callbacks are replay-guarded
  by event id and compared in constant time. A leaked callback URL alone does nothing.
- **Toll fraud.** The third party chooses where the caller goes, so the destination allow-list is
  mandatory and an empty one is a publish error.
- **Operator access.** Desk routes need a session, `viewer`, an enabled profile and team membership of
  the ticket's queue; caller numbers are masked in lists and shown only in the accepted context if the
  policy allows. Accept is idempotent by key.
- **Room tokens.** Short-lived, room-scoped, audio only; the API secret never reaches a browser, a log
  or an event. Rotation: set the previous pair, deploy with `--recreate-livekit`.
- **Data.** Context lives in the ticket row only (not events, logs, outcome summaries or the LLM
  prompt), is returned `no-store`, and is scrubbed after retention. The summary and transcript are
  caller-derived, untrusted text: the desk renders them as text and a mapping never evaluates them.
- **Mappings.** A mapping reads a fixed namespace, only the fields the queue's context policy turns
  on, and has no evaluation, loops or user regular expressions.

## Walkthrough: a third-party queue

```jsonc
// 1. POST /v1/human-queues   (editor)  ->  201 + ETag
{ "definition": { "kind": "external", "name": "Acme ACD",
  "webhook": { "url": "https://acd.example.com/ovo/handoff", "credentialId": "acd-hmac",
    "body": { "callId": { "$from": "call.id" }, "lang": { "$from": "route.language", "default": "en" },
              "notes": { "$template": "Intent {{route.intent}}: {{handover.summary}}", "maxChars": 500 },
              "replyTo": { "$from": "ticket.callbackUrl" } },
    "response": { "statusPath": "/result", "acceptedValues": ["ok"], "destinationE164Path": "/dial/number" } },
  "destination": { "allowE164Prefixes": ["+9140"], "allowSipHosts": [".acd.example.com"], "allowedHeaders": ["X-Acd-Ticket"] } } }
// 2. POST /v1/human-queues/<id>/test-webhook   (admin): a synthetic call, the real client, no ticket.
// 3. Bind it in the point draft and use it:
{ "humanQueues": [{ "key": "support-desk", "queueId": "<queue id>" }],
  "nodes": [{ "id": "intent", "…": "…", "fallback": [{ "kind": "human", "queueId": "support-desk" }, { "kind": "default" }] }] }
// 4. Publish, then bind a number to the release (OVO_HUMAN_QUEUE_ENABLED, _WEBHOOK_ENABLED, routing
//    and transfer on). The onboarding steps and a receiver sample: docs/runbooks/human-queue-webhook.md.
```

## Walkthrough: the operator desk

1. Run the room server (`docs/runbooks/livekit-deploy.md`) and set `OVO_LIVEKIT_ENABLED=true`.
2. Create a managed queue (`kind: "managed"`, `teamIds`, `assignment`, `returnTargets` naming
   catalogue keys, optional `wrapUp`). Bind it in the point draft like a pool.
3. Add operators: `PUT /v1/human-queues/operators/<userId>` (admin) with their teams, languages and
   capacity.
4. The operator opens **Operator desk**, tests the microphone, goes Available, and accepts calls.
   Day-to-day use and troubleshooting: `docs/runbooks/operator-desk.md`.

## What ships where

`packages/contracts/src/human-queue/` (queue, webhook spec, mapping DSL and pure render, response
parsing, destination check, ticket and desk DTOs, the `MediaRoomProvider` and `RoomSeat` ports,
events, issue codes); `packages/plugin-operations/src/human-queue/` (the service port, the engine,
the in-memory and PostgreSQL stores, the sweeper task, the `HumanHandoffPort` adapter) and
`migrations/013_human_queues.sql`; `packages/plugin-storage` outcomes v4; `packages/conformance`
(`describeMediaRoom`, `fakeMediaRoom`); `packages/plugin-room-livekit` (the only code that names the
room server); `packages/distribution` (the profile rows); `infra/compose` (the `livekit` service).

## What later waves add

The routing designer and the call simulator (R4) edit `humanQueues` and the `human` targets with the
same structural issue codes (`routing_queue_*`). Supervisor listen-in, whisper and barge reuse the
`monitor` token role and the command union. Skills-based routing, abandonment analytics, SMS or
WhatsApp hand-offs and CRM-aware routing are not in R3.
